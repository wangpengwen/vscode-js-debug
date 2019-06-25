// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {Target} from './targetManager';
import * as debug from 'debug';
import {EventEmitter} from 'events';
import {Source, Location} from './source';
import * as utils from '../utils';
import {Cdp, CdpApi} from '../cdp/api';
import {PausedDetails} from './pausedDetails';

const debugThread = debug('thread');

export const ThreadEvents = {
  ThreadNameChanged: Symbol('ThreadNameChanged'),
  ThreadPaused: Symbol('ThreadPaused'),
  ThreadResumed: Symbol('ThreadResumed'),
  ThreadConsoleMessage: Symbol('ThreadConsoleMessage'),
};

export class Thread extends EventEmitter {
  private static _lastThreadId: number = 0;

  private _target: Target;
  private _threadId: number;
  private _threadName: string;
  private _pausedDetails?: PausedDetails;
  private _scripts: Map<string, Source> = new Map();

  constructor(target: Target) {
    super();
    this._target = target;
    this._threadId = ++Thread._lastThreadId;
    this._threadName = '';
    debugThread(`Thread created #${this._threadId}`);
  }

  cdp(): CdpApi {
    return this._target.cdp();
  }

  threadId(): number {
    return this._threadId;
  }

  threadName(): string {
    return this._threadName;
  }

  pausedDetails(): PausedDetails | undefined {
    return this._pausedDetails;
  }

  scripts(): Map<string, Source> {
    return this._scripts;
  }

  resume() {
    this._target.cdp().Debugger.resume();
  }

  async initialize() {
    const cdp = this._target.cdp();
    cdp.Runtime.on('executionContextsCleared', () => this._reset());
    cdp.Runtime.on('consoleAPICalled', event => {
      this.emit(ThreadEvents.ThreadConsoleMessage, { thread: this, event });
    });
    await cdp.Runtime.enable();
    cdp.Debugger.on('paused', event => {
      this._pausedDetails = new PausedDetails(this, event);
      this.emit(ThreadEvents.ThreadPaused, this);
    });
    cdp.Debugger.on('resumed', () => {
      this._pausedDetails = undefined;
      this.emit(ThreadEvents.ThreadResumed, this);
    });
    cdp.Debugger.on('scriptParsed', (event: Cdp.Debugger.ScriptParsedEvent) => this._onScriptParsed(event));
    await cdp.Debugger.enable({});
    await cdp.Debugger.setAsyncCallStackDepth({maxDepth: 32});
  }

  async dispose() {
    this._reset();
    debugThread(`Thread destroyed #${this._threadId}: ${this._threadName}`);
  }

  setThreadName(threadName: string) {
    this._threadName = threadName;
    debugThread(`Thread renamed #${this._threadId}: ${this._threadName}`);
    this.emit(ThreadEvents.ThreadNameChanged, this);
  }

  rawLocation(callFrame: Cdp.Debugger.CallFrame | Cdp.Runtime.CallFrame): Location {
    if (callFrame['location']) {
      const frame = callFrame as Cdp.Debugger.CallFrame;
      return {
        url: frame.url,
        lineNumber: frame.location.lineNumber,
        columnNumber: frame.location.columnNumber,
        source: this._scripts.get(frame.location.scriptId)
      };
    }
    const frame = callFrame as Cdp.Runtime.CallFrame;
    return {
      url: frame.url,
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
      source: this._scripts.get(frame.scriptId)
    };
  }

  _reset() {
    const scripts = Array.from(this._scripts.values());
    this._scripts.clear();
    this._target.sourceContainer().removeSources(...scripts);
    this._pausedDetails = undefined;
  }

  _onScriptParsed(event: Cdp.Debugger.ScriptParsedEvent) {
    const readableUrl = event.url || `VM${event.scriptId}`;
    const source = Source.createWithContentGetter(readableUrl, async () => {
      const response = await this._target.cdp().Debugger.getScriptSource({scriptId: event.scriptId});
      return response.scriptSource;
    });
    this._scripts.set(event.scriptId, source);
    this._target.sourceContainer().addSource(source);
    if (event.sourceMapURL) {
      // TODO(dgozman): reload source map when target url changes.
      const resolvedSourceUrl = utils.completeUrl(this._target.url(), event.url);
      const resolvedSourceMapUrl = resolvedSourceUrl && utils.completeUrl(resolvedSourceUrl, event.sourceMapURL);
      if (resolvedSourceMapUrl)
        this._target.sourceContainer().attachSourceMap(source, resolvedSourceMapUrl);
    }
  }
};