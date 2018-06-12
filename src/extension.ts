/**
 * Extension startup/teardown
 */ /** */

'use strict';

require('module-alias/register');

import * as vscode from 'vscode';
import * as path from 'path';
import * as logging from './logging';
import * as util from './util';

const log = logging.createLogger('extension');

// import * as api from './api';
// import { CMakeToolsWrapper } from './wrapper';
// import { log } from './logging';
// import { outputChannels } from "./util";

import CMakeTools from './cmake-tools';
import rollbar from './rollbar';
import {
  Kit,
  readKitsFile,
  scanForKits,
  descriptionForKit,
  USER_KITS_FILEPATH,
  kitsPathForWorkspaceFolder,
} from '@cmt/kit';
import {fs} from '@cmt/pr';
import {MultiWatcher} from '@cmt/watcher';
import {ConfigurationReader} from '@cmt/config';
import paths from '@cmt/paths';
import {Strand} from '@cmt/strand';
import {StatusBar} from './status';
import {FireNow} from '@cmt/prop';

class DummyDisposable {
  dispose() {}
}

interface ProgressReport {
  message: string;
  increment?: number;
}

type ProgressHandle = vscode.Progress<ProgressReport>;

function reportProgress(progress: ProgressHandle|undefined, message: string) {
  if (progress) {
    progress.report({message});
  }
}

/**
 * A class to manage the extension.
 *
 * Yeah, yeah. It's another "Manager", but this is to be the only one.
 *
 * This is the true "singleton" of the extension. It acts as the glue between
 * the lower layers and the VSCode UX. When a user presses a button to
 * necessitate user input, this class acts as intermediary and will send
 * important information down to the lower layers.
 */

class ExtensionManager implements vscode.Disposable {
  constructor(public readonly extensionContext: vscode.ExtensionContext) {}

  /**
   * Subscription to workspace changes.
   *
   * When a workspace is added or removed, the instances of CMakeTools are
   * update to match the new state.
   *
   * For each workspace folder, a separate instance of CMake Tools is
   * maintained. This allows each folder to both share configuration as well as
   * keep its own separately.
   */
  private readonly _workspaceFoldersChangedSub = vscode.workspace.onDidChangeWorkspaceFolders(
      e => rollbar.invokeAsync('Update workspace folders', () => this._onWorkspaceFoldersChanged(e)));

  /**
   * Adding/removing workspaces should be serialized. Keep that work in a strand.
   */
  private readonly _wsModStrand = new Strand();

  /**
   * Handle workspace change event.
   * @param e Workspace change event
   */
  private async _onWorkspaceFoldersChanged(e: vscode.WorkspaceFoldersChangeEvent) {
    // Un-register each CMake Tools we have loaded for each removed workspace
    for (const removed of e.removed) {
      await this._removeWorkspaceFolder(removed);
    }
    // Load a new CMake Tools instance for each folder that has been added.
    for (const added of e.added) {
      await this.addWorkspaceFolder(added);
    }
  }

  /**
   * The CMake Tools backend instances available in the extension. The reason
   * for multiple is so that each workspace folder may have its own unique instance
   */
  private readonly _cmakeToolsInstances: Map<string, CMakeTools> = new Map();

  /**
   * The status bar controller
   */
  private readonly _statusBar = new StatusBar();
  // Subscriptions for status bar items:
  private _statusMessageSub: vscode.Disposable = new DummyDisposable();
  private _targetNameSub: vscode.Disposable = new DummyDisposable();
  private _projectNameSub: vscode.Disposable = new DummyDisposable();
  private _buildTypeSub: vscode.Disposable = new DummyDisposable();
  private _launchTargetSub: vscode.Disposable = new DummyDisposable();
  private _ctestEnabledSub: vscode.Disposable = new DummyDisposable();
  private _testResultsSub: vscode.Disposable = new DummyDisposable();
  private _isBusySub: vscode.Disposable = new DummyDisposable();
  private _progressSub: vscode.Disposable = new DummyDisposable();

  /**
   * The active workspace folder. This controls several aspects of the extension,
   * including:
   *
   * - Which CMakeTools backend receives commands from the user
   * - Where we search for variants
   * - Where we search for workspace-local kits
   */
  private _activeWorkspaceFolder: vscode.WorkspaceFolder|null = null;

  /**
   * The CMake Tools instance associated with the current workspace folder, or
   * `null` if no folder is open.
   */
  private get _activeCMakeTools(): CMakeTools|null {
    if (this._activeWorkspaceFolder) {
      const ret = this._cmakeToolsForWorkspaceFolder(this._activeWorkspaceFolder);
      if (!ret) {
        rollbar.error('No active CMake Tools attached to the current workspace. Impossible!');
        return null;
      }
      return ret;
    }
    return null;
  }

  /**
   * Get the CMakeTools instance associated with the given workspace folder, or `null`
   * @param ws The workspace folder to search
   */
  private _cmakeToolsForWorkspaceFolder(ws: vscode.WorkspaceFolder): CMakeTools|null {
    return this._cmakeToolsInstances.get(ws.name) || null;
  }

  /**
   * Ensure that there is an active kit for the current CMakeTools.
   *
   * @returns `false` if there is not active CMakeTools, or it has no active kit
   * and the user cancelled the kit selection dialog.
   */
  private async _ensureActiveKit(): Promise<boolean> {
    const cmt = this._activeCMakeTools;
    if (!cmt) {
      // No CMakeTools. Probably no workspace open.
      return false;
    }
    if (cmt.activeKit) {
      // We have an active kit. We're good.
      return true;
    }
    // No kit? Ask the user what they want.
    const did_choose_kit = await this.selectKit();
    if (!did_choose_kit) {
      // The user did not choose a kit
      return false;
    }
    // Return whether we have an active kit defined.
    return !!cmt.activeKit;
  }

  /**
   * Dispose of the CMake Tools extension.
   *
   * If you can, prefer to call `asyncDispose`, which awaits on the children.
   */
  dispose() { rollbar.invokeAsync('Dispose of CMake Tools', () => this.asyncDispose()); }

  /**
   * Asynchronously dispose of all the child objects.
   */
  async asyncDispose() {
    this._disposeStatusSubs();
    this._workspaceFoldersChangedSub.dispose();
    this._kitsWatcher.dispose();
    this._editorWatcher.dispose();
    // Dispose of each CMake Tools we still have loaded
    for (const cmt of this._cmakeToolsInstances.values()) {
      await cmt.asyncDispose();
    }
  }

  /**
   * Create a new instance of the backend to support the given workspace folder.
   * The given folder *must not* already be loaded.
   * @param ws The workspace folder to load for
   * @returns The newly created CMakeTools backend for the given folder
   */
  async addWorkspaceFolder(ws: vscode.WorkspaceFolder, progress?: ProgressHandle): Promise<CMakeTools> {
    return this._wsModStrand.execute(async () => {
      // Check that we aren't double-loading for this workspace. That would be bad...
      const current_cmt = this._cmakeToolsForWorkspaceFolder(ws)!;
      if (current_cmt) {
        rollbar.error('Double-loaded CMake Tools instance for workspace folder', {wsUri: ws.uri.toString()});
        // Not even sure how to best handle this...
        return current_cmt;
      }
      // Load for the workspace.
      reportProgress(progress, 'Creating backend');
      const new_cmt = await this._loadCMakeToolsForWorkspaceFolder(ws);
      // If we didn't have anything active, mark the freshly loaded instance as active
      if (this._activeWorkspaceFolder === null) {
        await this._setActiveWorkspaceFolder(ws, progress);
      }
      // Return the newly created instance
      return new_cmt;
    });
  }

  /**
   * Load a new CMakeTools for the given workspace folder and remember it.
   * @param ws The workspace folder to load for
   */
  private async _loadCMakeToolsForWorkspaceFolder(ws: vscode.WorkspaceFolder) {
    // New instance
    const new_cmt = await this._createCMakeToolsForWorkspaceFolder(ws);
    // Save the instance:
    this._cmakeToolsInstances.set(ws.name, new_cmt);
    return new_cmt;
  }

  /**
   * Create a new CMakeTools instance for the given WorkspaceFolder
   * @param ws The workspace folder to create for
   */
  private async _createCMakeToolsForWorkspaceFolder(ws: vscode.WorkspaceFolder) {
    return CMakeTools.createForDirectory(ws.uri.fsPath, this.extensionContext);
  }

  /**
   * Remove knowledge of the given workspace folder. Disposes of the CMakeTools
   * instance associated with the workspace.
   * @param ws The workspace to remove for
   */
  private _removeWorkspaceFolder(ws: vscode.WorkspaceFolder) {
    // Keep this work in a strand
    return this._wsModStrand.execute(async () => {
      const inst = this._cmakeToolsForWorkspaceFolder(ws);
      if (!inst) {
        // CMake Tools should always be aware of all workspace folders. If we
        // somehow missed one, that's a bug
        rollbar.error('Workspace folder removed, but not associated with an extension instance', {wsName: ws.name});
        // Keep the UI running, just don't remove this instance.
        return;
      }
      // If the removed workspace is the active one, reset the active instance.
      if (inst === this._activeCMakeTools) {
        // Forget about the workspace
        await this._setActiveWorkspaceFolder(null);
      }
      // Drop the instance from our table. Forget about it.
      this._cmakeToolsInstances.delete(ws.name);
      // Finally, dispose of the CMake Tools now that the workspace is gone.
      await inst.asyncDispose();
    });
  }

  /**
   * Set the active workspace folder. This reloads a lot of different bits and
   * pieces to control which backend has control and receives user input.
   * @param ws The workspace to activate
   */
  private async _setActiveWorkspaceFolder(ws: vscode.WorkspaceFolder|null, progress?: ProgressHandle) {
    reportProgress(progress, `Loading workspace folder ${ws ? ws.name : ''}`);
    // Keep it in the strand
    // We SHOULD have a CMakeTools instance loaded for this workspace.
    // It should have been added by `addWorkspaceFolder`
    if (ws && !this._cmakeToolsInstances.has(ws.name)) {
      rollbar.error('No CMake Tools instance ready for the active workspace. Impossible!', {wsUri: ws.uri.toString()});
      return;
    }
    // Set the new workspace
    this._activeWorkspaceFolder = ws;
    // Drop the old kit watcher on the floor
    this._resetKitsWatcher();
    // Re-read kits for the new workspace:
    await this._rereadKits(progress);
    this._setupStatusBarSubs();
  }

  private _disposeStatusSubs() {
    for (const sub of [this._statusMessageSub,
                       this._targetNameSub,
                       this._projectNameSub,
                       this._buildTypeSub,
                       this._launchTargetSub,
                       this._ctestEnabledSub,
                       this._testResultsSub,
                       this._isBusySub,
                       this._progressSub,
    ]) {
      sub.dispose();
    }
  }

  private _setupStatusBarSubs() {
    this._disposeStatusSubs();
    const cmt = this._activeCMakeTools;
    this._statusBar.setVisible(true);
    if (!cmt) {
      this._statusMessageSub = new DummyDisposable();
      this._targetNameSub = new DummyDisposable();
      this._projectNameSub = new DummyDisposable();
      this._buildTypeSub = new DummyDisposable();
      this._launchTargetSub = new DummyDisposable();
      this._ctestEnabledSub = new DummyDisposable();
      this._testResultsSub = new DummyDisposable();
      this._isBusySub = new DummyDisposable();
      this._progressSub = new DummyDisposable();
    } else {
      this._statusMessageSub = cmt.onStatusMessageChanged(FireNow, s => this._statusBar.setStatusMessage(s));
      this._targetNameSub = cmt.onTargetNameChanged(FireNow, t => this._statusBar.targetName = t);
      this._projectNameSub = cmt.onProjectNameChanged(FireNow, p => this._statusBar.setProjectName(p));
      this._buildTypeSub = cmt.onBuildTypeChanged(FireNow, bt => this._statusBar.setBuildTypeLabel(bt));
      this._launchTargetSub = cmt.onLaunchTargetNameChanged(FireNow, t => this._statusBar.setLaunchTargetName(t || ''));
      this._ctestEnabledSub = cmt.onCTestEnabledChanged(FireNow, e => this._statusBar.ctestEnabled = e);
      this._testResultsSub = cmt.onTestResultsChanged(FireNow, r => this._statusBar.testResults = r);
      this._isBusySub = cmt.onIsBusyChanged(FireNow, b => this._statusBar.setIsBusy(b));
      this._progressSub = cmt.onProgress(p => this._statusBar.setProgress(p));
    }
  }

  /**
   * Drop the current kits watcher and create a new one.
   */
  private _resetKitsWatcher() {
    // Throw the old one away
    this._kitsWatcher.dispose();
    // Determine whether we need to watch the workspace kits file:
    const ws_kits_path = this._workspaceKitsPath;
    this._kitsWatcher = ws_kits_path
        // We have workspace kits:
        ? new MultiWatcher(USER_KITS_FILEPATH, ws_kits_path)
        // No workspace:
        : new MultiWatcher(USER_KITS_FILEPATH);
    // Subscribe to its events:
    this._kitsWatcher.onAnyEvent(_ => rollbar.invokeAsync('Re-reading kits', () => this._rereadKits()));
  }

  /**
   * The path to the workspace-local kits file, dependent on the path to the
   * active workspace folder.
   */
  private get _workspaceKitsPath(): string|null {
    return this._activeWorkspaceFolder
        // Path present:
        ? kitsPathForWorkspaceFolder(this._activeWorkspaceFolder)
        // No open folder:
        : null;
  }

  /**
   * The kits available from the user-local kits file
   */
  private _userKits: Kit[] = [];

  /**
   * The kits available from the workspace kits file
   */
  private _wsKits: Kit[] = [];

  /**
   * Watches for changes to the kits file
   */
  private _kitsWatcher: MultiWatcher = new MultiWatcher(USER_KITS_FILEPATH);

  /**
   * Watch for text edits. At the moment, this only watches for changes to the
   * kits files, since the filesystem watcher in the `_kitsWatcher` is sometimes
   * unreliable.
   */
  private readonly _editorWatcher = vscode.workspace.onDidSaveTextDocument(doc => {
    if (doc.uri.fsPath === USER_KITS_FILEPATH) {
      rollbar.takePromise('Re-reading kits on text edit', {}, this._rereadKits());
    } else if (this._workspaceKitsPath && doc.uri.fsPath === this._workspaceKitsPath) {
      rollbar.takePromise('Re-reading kits on text edit', {}, this._rereadKits());
    } else {
      // Ignore
    }
  });

  /**
   * Get both workspace-local kits and user-local kits
   */
  private get _allKits(): Kit[] { return this._userKits.concat(this._wsKits); }

  /**
   * Reload the list of available kits from the filesystem. This will also
   * update the kit loaded into the current backend if applicable.
   */
  private async _rereadKits(progress?: ProgressHandle) {
    // Load user-kits
    reportProgress(progress, 'Loading kits');
    const user = await readKitsFile(USER_KITS_FILEPATH);
    // Conditionally load workspace kits
    let workspace: Kit[] = [];
    if (this._workspaceKitsPath) {
      workspace = await readKitsFile(this._workspaceKitsPath);
    }
    // Add the special __unspec__ kit for opting-out of kits
    user.push({name: '__unspec__'});
    // Set them as known. May reload the current kit.s
    await this._setKnownKits({user, workspace});
    // Pruning requires user interaction, so it happens fully async
    this._startPruneOutdatedKitsAsync();
  }

  /**
   * Set the kits that are available to the user. May change the active kit.
   * @param opts `user` for user local kits, `workspace` for workspace-local kits
   */
  private async _setKnownKits(opts: {user: Kit[], workspace: Kit[]}) {
    this._userKits = opts.user;
    this._wsKits = opts.workspace;
    const cmt = this._activeCMakeTools;
    if (cmt) {
      const current = cmt.activeKit;
      if (current) {
        const already_active_kit = this._allKits.find(kit => kit.name === current.name);
        // Set the current kit to the one we have named
        await this._setCurrentKit(already_active_kit || null);
      }
    }
  }

  /**
   * Set the current kit in the current CMake Tools instance
   * @param k The kit
   */
  async _setCurrentKit(k: Kit|null) {
    const inst = this._activeCMakeTools;
    if (inst) {
      await inst.setKit(k);
    }
  }

  /**
   * Opens a text editor with the user-local `cmake-kits.json` file.
   */
  async editKits(): Promise<vscode.TextEditor|null> {
    log.debug('Opening TextEditor for', USER_KITS_FILEPATH);
    if (!await fs.exists(USER_KITS_FILEPATH)) {
      interface Item extends vscode.MessageItem {
        action: 'scan'|'cancel';
      }
      const chosen = await vscode.window.showInformationMessage<Item>(
          'No kits file is present. What would you like to do?',
          {modal: true},
          {
            title: 'Scan for kits',
            action: 'scan',
          },
          {
            title: 'Cancel',
            isCloseAffordance: true,
            action: 'cancel',
          },
      );
      if (!chosen || chosen.action === 'cancel') {
        return null;
      } else {
        await this.scanForKits();
        return this.editKits();
      }
    }
    const doc = await vscode.workspace.openTextDocument(USER_KITS_FILEPATH);
    return vscode.window.showTextDocument(doc);
  }

  /**
   * Rescan the system for kits and save them to the user-local kits file
   */
  async scanForKits() {
    log.debug('Rescanning for kits');
    // Convert the kits into a by-name mapping so that we can restore the ones
    // we know about after the fact.
    // We only save the user-local kits: We don't want to save workspace kits
    // in the user kits file.
    const old_kits_by_name = this._userKits.reduce(
        (acc, kit) => ({...acc, [kit.name]: kit}),
        {} as {[kit: string]: Kit},
    );
    // Do the scan:
    const discovered_kits = await scanForKits({minGWSearchDirs: this._getMinGWDirs()});
    // Update the new kits we know about.
    const new_kits_by_name = discovered_kits.reduce(
        (acc, kit) => ({...acc, [kit.name]: kit}),
        old_kits_by_name,
    );

    const new_kits = Object.keys(new_kits_by_name).map(k => new_kits_by_name[k]);
    await this._setKnownKits({user: new_kits, workspace: this._wsKits});
    await this._writeUserKitsFile(new_kits);
    this._startPruneOutdatedKitsAsync();
  }

  /**
   * Get the current MinGW search directories
   */
  private _getMinGWDirs(): string[] {
    const cmt = this._activeCMakeTools;
    if (!cmt) {
      // No CMake Tools, but can guess what settings we want.
      const config = ConfigurationReader.loadForPath(process.cwd());
      return config.mingwSearchDirs;
    } else {
      return cmt.workspaceContext.config.mingwSearchDirs;
    }
  }

  /**
   * Write the given kits the the user-local cmake-kits.json file.
   * @param kits The kits to write to the file.
   */
  private async _writeUserKitsFile(kits: Kit[]) {
    log.debug('Saving kits to', USER_KITS_FILEPATH);
    // Remove the special __unspec__ kit
    const stripped_kits = kits.filter(k => k.name !== '__unspec__');
    // Sort the kits by name so they always appear in order in the file.
    const sorted_kits = stripped_kits.sort((a, b) => {
      if (a.name == b.name) {
        return 0;
      } else if (a.name < b.name) {
        return -1;
      } else {
        return 1;
      }
    });
    // Do the save.
    try {
      log.debug('Saving new kits to', USER_KITS_FILEPATH);
      // Create the directory where the kits will go
      await fs.mkdir_p(path.dirname(USER_KITS_FILEPATH));
      // Write the file
      await fs.writeFile(USER_KITS_FILEPATH, JSON.stringify(sorted_kits, null, 2));
    } catch (e) {
      // Failed to write the file. What to do...
      interface FailOptions extends vscode.MessageItem {
        do: 'retry' | 'cancel';
      }
      const pr = vscode.window
                     .showErrorMessage<FailOptions>(
                         `Failed to write kits file to disk: ${USER_KITS_FILEPATH}: ${e.toString()}`,
                         {
                           title: 'Retry',
                           do: 'retry',
                         },
                         {
                           title: 'Cancel',
                           do: 'cancel',
                         },
                         )
                     .then(choice => {
                       if (!choice) {
                         return false;
                       }
                       switch (choice.do) {
                       case 'retry':
                         return this.scanForKits();
                       case 'cancel':
                         return false;
                       }
                     });
      // Don't block on writing re-trying the write
      rollbar.takePromise('retry-kit-save-fail', {}, pr);
      return false;
    }
  }

  /**
   * User-interactive kit pruning:
   *
   * This function will find all user-local kits that identify files that are
   * no longer present (such as compiler binaries), and will show a popup
   * notification to the user requesting an action.
   *
   * This function will not prune kits that have the `keep` field marked `true`
   *
   * If the user chooses to remove the kit, we call `_removeKit()` and erase it
   * from the user-local file.
   *
   * If the user chooses to keep teh kit, we call `_keepKit()` and set the
   * `keep` field on the kit to `true`.
   *
   * Always returns immediately.
   */
  private _startPruneOutdatedKitsAsync() {
    // Iterate over _user_ kits. We don't care about workspace-local kits
    for (const kit of this._userKits) {
      if (kit.keep === true) {
        // Kit is explicitly marked to be kept
        continue;
      }
      if (!kit.compilers) {
        // We only prune kits with a `compilers` field.
        continue;
      }
      // Accrue a list of promises that resolve to whether a give file exists
      interface FileInfo {
        path: string;
        exists: boolean;
      }
      const missing_paths_prs: Promise<FileInfo>[] = [];
      for (const lang in kit.compilers) {
        const comp_path = kit.compilers[lang];
        // Get a promise that resolve to whether the given path/name exists
        const exists_pr = path.isAbsolute(comp_path)
            // Absolute path, just check if it exists
            ? fs.exists(comp_path)
            // Non-absolute. Check on $PATH
            : paths.which(comp_path).then(v => v !== null);
        // Add it to the list
        missing_paths_prs.push(exists_pr.then(exists => ({exists, path: comp_path})));
      }
      const pr = Promise.all(missing_paths_prs).then(async infos => {
        const missing = infos.find(i => !i.exists);
        if (!missing) {
          return;
        }
        // This kit contains a compiler that does not exist. What to do?
        interface UpdateKitsItem extends vscode.MessageItem {
          action: 'remove'|'keep';
        }
        const chosen = await vscode.window.showInformationMessage<UpdateKitsItem>(
            `The kit "${kit.name}" references a non-existent compiler binary [${missing.path}]. ` +
                `What would you like to do?`,
            {},
            {
              action: 'remove',
              title: 'Remove it',
            },
            {
              action: 'keep',
              title: 'Keep it',
            },
        );
        if (chosen === undefined) {
          return;
        }
        switch (chosen.action) {
        case 'keep':
          return this._keepKit(kit);
        case 'remove':
          return this._removeKit(kit);
        }
      });
      rollbar.takePromise(`Pruning kit`, {kit}, pr);
    }
  }

  /**
   * Mark a kit to be "kept". This set the `keep` value to `true` and writes
   * re-writes the user kits file.
   * @param kit The kit to mark
   */
  private async _keepKit(kit: Kit) {
    const new_kits = this._userKits.map(k => {
      if (k.name === kit.name) {
        return {...k, keep: true};
      } else {
        return k;
      }
    });
    await this._setKnownKits({user: new_kits, workspace: this._wsKits});
    return this._writeUserKitsFile(new_kits);
  }

  /**
   * Remove a kit from the user-local kits.
   * @param kit The kit to remove
   */
  private async _removeKit(kit: Kit) {
    const new_kits = this._userKits.filter(k => k.name !== kit.name);
    await this._setKnownKits({user: new_kits, workspace: this._wsKits});
    return this._writeUserKitsFile(new_kits);
  }

  private async _checkHaveKits(): Promise<'use-unspec'|'ok'|'cancel'> {
    if (this._allKits.length > 1) {
      // We have kits. Okay.
      return 'ok';
    }
    if (this._allKits[0].name !== '__unspec__') {
      // We should _always_ have an __unspec__ kit.
      rollbar.error('Invalid only kit. Expected to find `__unspec__`');
      return 'ok';
    }
    // We don't have any kits defined. Ask the user what to do. This is safe to block
    // because it is a modal dialog
    interface FirstScanItem extends vscode.MessageItem {
      action: 'scan'|'use-unspec'|'cancel';
    }
    const choices: FirstScanItem[] = [
      {
        title: 'Scan for kits',
        action: 'scan',
      },
      {
        title: 'Do not use a kit',
        action: 'use-unspec',
      },
      {
        title: 'Close',
        isCloseAffordance: true,
        action: 'cancel',
      }
    ];
    const chosen = await vscode.window.showInformationMessage(
        'No CMake kits are available. What would you like to do?',
        {modal: true},
        ...choices,
    );
    if (!chosen) {
      // User closed the dialog
      return 'cancel';
    }
    switch (chosen.action) {
    case 'scan': {
      await this.scanForKits();
      return 'ok';
    }
    case 'use-unspec': {
      await this._setCurrentKit({name: '__unspec__'});
      return 'use-unspec';
    }
    case 'cancel': {
      return 'cancel';
    }
    }
  }

  /**
   * Show UI to allow the user to select an active kit
   */
  async selectKit(): Promise<boolean> {
    log.debug('Start selection of kits. Found', this._allKits.length, 'kits.');

    // Check that we have kits, or if the user doesn't want to use a kit.
    const state = await this._checkHaveKits();
    switch (state) {
    case 'cancel':
      // The user doesn't want to perform any special action
      return false;
    case 'use-unspec':
      // The user chose to use the __unspec__ kit
      return true;
    case 'ok':
      // 'ok' means we have kits defined and should do regular kit selection
      break;
    }

    interface KitItem extends vscode.QuickPickItem {
      kit: Kit;
    }
    log.debug('Opening kit selection QuickPick');
    // Generate the quickpick items from our known kits
    const items = this._allKits.map(
        (kit): KitItem => ({
          label: kit.name !== '__unspec__' ? kit.name : '[Unspecified]',
          description: descriptionForKit(kit),
          kit,
        }),
    );
    const chosen_kit = await vscode.window.showQuickPick(items, {placeHolder: 'Select a Kit'});
    if (chosen_kit === undefined) {
      log.debug('User cancelled Kit selection');
      // No selection was made
      return false;
    } else {
      log.debug('User selected kit ', JSON.stringify(chosen_kit));
      await this._setCurrentKit(chosen_kit.kit);
      return true;
    }
  }

  /**
   * Wraps an operation that requires an open workspace and kit selection. If
   * there is no active CMakeTools (no open workspace) or if the user cancels
   * kit selection, we return the given default value.
   * @param default_ The default return value
   * @param fn The callback
   */
  async withCMakeTools<Ret>(default_: Ret, fn: (cmt: CMakeTools) => Ret | Thenable<Ret>): Promise<Ret> {
    // Check that we have an active CMakeTools instance.
    const cmt = this._activeCMakeTools;
    if (!cmt) {
      vscode.window.showErrorMessage('CMake Tools is not available without an open workspace');
      return Promise.resolve(default_);
    }
    // Ensure that we have a kit available.
    if (!await this._ensureActiveKit()) {
      return Promise.resolve(default_);
    }
    // We have a kit, and we have a CMakeTools. Call the function
    return Promise.resolve(fn(cmt));
  }

  // The below functions are all wrappers around the backend.

  cleanConfigure() { return this.withCMakeTools(-1, cmt => cmt.cleanConfigure()); }

  configure() { return this.withCMakeTools(-1, cmt => cmt.configure()); }

  build() { return this.withCMakeTools(-1, cmt => cmt.build()); }

  setVariant() { return this.withCMakeTools(false, cmt => cmt.setVariant()); }

  install() { return this.withCMakeTools(-1, cmt => cmt.install()); }

  editCache() { return this.withCMakeTools(undefined, cmt => cmt.editCache()); }

  clean() { return this.withCMakeTools(-1, cmt => cmt.clean()); }

  cleanRebuild() { return this.withCMakeTools(-1, cmt => cmt.cleanRebuild()); }

  buildWithTarget() { return this.withCMakeTools(-1, cmt => cmt.buildWithTarget()); }

  setDefaultTarget() { return this.withCMakeTools(undefined, cmt => cmt.setDefaultTarget()); }

  ctest() { return this.withCMakeTools(-1, cmt => cmt.ctest()); }

  stop() { return this.withCMakeTools(false, cmt => cmt.stop()); }

  quickStart() { return this.withCMakeTools(-1, cmt => cmt.quickStart()); }

  launchTargetPath() { return this.withCMakeTools(null, cmt => cmt.launchTargetPath()); }

  debugTarget() { return this.withCMakeTools(null, cmt => cmt.debugTarget()); }

  launchTarget() { return this.withCMakeTools(null, cmt => cmt.launchTarget()); }

  selectLaunchTarget() { return this.withCMakeTools(null, cmt => cmt.selectLaunchTarget()); }

  resetState() { return this.withCMakeTools(null, cmt => cmt.resetState()); }

  viewLog() { return this.withCMakeTools(null, cmt => cmt.viewLog()); }
}

/**
 * The global extension manager. There is only one of these, even if multiple
 * backends.
 */
let _EXT_MANAGER: ExtensionManager|null = null;

async function setup(context: vscode.ExtensionContext, progress: vscode.Progress<ProgressReport>) {
  reportProgress(progress, 'Initial setup');
  // Load a new extension manager
  const ext = _EXT_MANAGER = new ExtensionManager(context);
  // Add all open workspace folders to the manager.
  for (const wsf of vscode.workspace.workspaceFolders || []) {
    reportProgress(progress, `Loading workspace folder ${wsf.name}`);
    await ext.addWorkspaceFolder(wsf, progress);
  }

  // A register function that helps us bind the commands to the extension
  function register<K extends keyof ExtensionManager>(name: K) {
    return vscode.commands.registerCommand(`cmake.${name}`, () => {
      // Generate a unqiue ID that can be correlated in the log file.
      const id = util.randint(1000, 10000);
      // Create a promise that resolves with the command.
      const pr = (async () => {
        // Debug when the commands start/stop
        log.debug(`[${id}]`, `cmake.${name}`, 'started');
        // Bind the method
        const fn = (ext[name] as Function).bind(ext);
        // Call the method
        const ret = await fn();
        try {
          // Log the result of the command.
          log.debug(`[${id}] cmake.${name} finished (returned ${JSON.stringify(ret)})`);
        } catch (e) {
          // Log, but don't try to serialize the return value.
          log.debug(`[${id}] cmake.${name} finished (returned an unserializable value)`);
        }
        // Return the result of the command.
        return ret;
      })();
      // Hand the promise to rollbar.
      rollbar.takePromise(name, {}, pr);
      // Return the promise so that callers will get the result of the command.
      return pr;
    });
  }

  // List of functions that will be bound commands
  const funs: (keyof ExtensionManager)[] = [
    'editKits',     'scanForKits',      'selectKit',        'cleanConfigure', 'configure',
    'build',        'setVariant',       'install',          'editCache',      'clean',
    'cleanRebuild', 'buildWithTarget',  'setDefaultTarget', 'ctest',          'stop',
    'quickStart',   'launchTargetPath', 'debugTarget',      'launchTarget',   'selectLaunchTarget',
    'resetState',   'viewLog',
    // 'toggleCoverageDecorations', // XXX: Should coverage decorations be revived?
  ];

  // Register the functions before the extension is done loading so that fast
  // fingers won't cause "unregistered command" errors while CMake Tools starts
  // up. The command wrapper will await on the extension promise.
  reportProgress(progress, 'Loading extension commands');
  for (const key of funs) {
    log.trace(`Register CMakeTools extension command cmake.${key}`);
    context.subscriptions.push(register(key));
  }
}

/**
 * Starts up the extension.
 * @param context The extension context
 * @returns A promise that will resolve when the extension is ready for use
 */
export async function activate(context: vscode.ExtensionContext) {
  vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CMake Tools initializing...',
        cancellable: false,
      },
      progress => setup(context, progress),
  );

  // TODO: Return the extension API
  // context.subscriptions.push(vscode.commands.registerCommand('cmake._extensionInstance', () => cmt));
}

// this method is called when your extension is deactivated
export async function deactivate() {
  log.debug('Deactivate CMakeTools');
  //   outputChannels.dispose();
  if (_EXT_MANAGER) {
    await _EXT_MANAGER.asyncDispose();
  }
}
