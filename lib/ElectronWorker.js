'use strict';

exports.__esModule = true;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _inherits(subClass, superClass) { if (typeof superClass !== 'function' && superClass !== null) { throw new TypeError('Super expression must either be null or a function, not ' + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var _events = require('events');

var _child_process = require('child_process');

var _child_process2 = _interopRequireDefault(_child_process);

var _cluster = require('cluster');

var _cluster2 = _interopRequireDefault(_cluster);

var _http = require('http');

var _http2 = _interopRequireDefault(_http);

var _debug = require('debug');

var _debug2 = _interopRequireDefault(_debug);

var _netCluster = require('net-cluster');

var _netCluster2 = _interopRequireDefault(_netCluster);

var _portscanner = require('portscanner');

var _portscanner2 = _interopRequireDefault(_portscanner);

var _uuid = require('uuid');

var _uuid2 = _interopRequireDefault(_uuid);

var _checkPortStatus = require('./checkPortStatus');

var _checkPortStatus2 = _interopRequireDefault(_checkPortStatus);

var _checkIpcStatus = require('./checkIpcStatus');

var _checkIpcStatus2 = _interopRequireDefault(_checkIpcStatus);

var _packageJson = require('../package.json');

var debugWorker = _debug2['default'](_packageJson.name + ':worker');

function findFreePort(host, cb) {
  var server = _netCluster2['default'].createServer(),
      port = 0;

  debugWorker('trying to find free port..');

  server.on('listening', function () {
    port = server.address().port;
    server.close();
  });

  server.on('close', function () {
    cb(null, port);
  });

  server.listen(0, host);
}

function findFreePortInRange(host, portLeftBoundary, portRightBoundary, cb) {
  var newPortLeftBoundary = portLeftBoundary;

  // in cluster we don't want ports to collide, so we make a special space for every
  // worker assuming max number of cluster workers is 5
  if (_cluster2['default'].worker) {
    newPortLeftBoundary = portLeftBoundary + (portRightBoundary - portLeftBoundary) / 5 * (_cluster2['default'].worker.id - 1);
  }

  debugWorker('trying to find free port in range ' + newPortLeftBoundary + '-' + portRightBoundary);

  _portscanner2['default'].findAPortNotInUse(newPortLeftBoundary, portRightBoundary, host, function (error, port) {
    cb(error, port);
  });
}

function isValidConnectionMode(mode) {
  if (mode !== 'server' && mode !== 'ipc') {
    return false;
  }

  return true;
}

var ElectronWorker = (function (_EventEmitter) {
  _inherits(ElectronWorker, _EventEmitter);

  function ElectronWorker(options) {
    _classCallCheck(this, ElectronWorker);

    _EventEmitter.call(this);

    this.options = options;
    this.firstStart = false;
    this.shouldRevive = false;
    this.exit = false;
    this.isBusy = false;
    this.isRecycling = false;
    this.id = _uuid2['default'].v1();
    this._hardKill = false;
    this._earlyError = false;
    this._taskCallback = {};

    this.onWorkerProcessError = this.onWorkerProcessError.bind(this);
    this.onWorkerProcessExitTryToRecyle = this.onWorkerProcessExitTryToRecyle.bind(this);
    this.onWorkerProcessIpcMessage = this.onWorkerProcessIpcMessage.bind(this);

    if (options.connectionMode === 'ipc') {
      this.findFreePort = function (cb) {
        cb(null);
      };
    } else {
      if (options.portLeftBoundary && options.portRightBoundary) {
        this.findFreePort = function (cb) {
          findFreePortInRange(options.host, options.portLeftBoundary, options.portRightBoundary, cb);
        };
      } else {
        this.findFreePort = function (cb) {
          findFreePort(options.host, cb);
        };
      }
    }
  }

  ElectronWorker.prototype.onWorkerProcessError = function onWorkerProcessError(workerProcessErr) {
    debugWorker('worker [' + this.id + '] electron process error callback: ' + workerProcessErr.message);

    // don't handle early errors (errors between spawning the process and the first checkAlive call) in this handler
    if (this._earlyError) {
      debugWorker('worker [' + this.id + '] ignoring error because it was handled previously (early): ' + workerProcessErr.message);
      return;
    }

    // try revive the process when an error is received,
    // note that could not be spawn errors are not handled here..
    if (this.firstStart && !this.isRecycling && !this.shouldRevive) {
      debugWorker('worker [' + this.id + '] the process will be revived because an error: ' + workerProcessErr.message);
      this.shouldRevive = true;
    }
  };

  ElectronWorker.prototype.onWorkerProcessExitTryToRecyle = function onWorkerProcessExitTryToRecyle(code, signal) {
    var _this = this;

    debugWorker('worker [' + this.id + '] onWorkerProcessExitTryToRecyle callback..');

    if (code != null || signal != null) {
      debugWorker('worker [' + this.id + '] electron process exit with code: ' + code + ' and signal: ' + signal);
    }

    // we only recycle the process on exit and if it is not in the middle
    // of another recycling
    if (this.firstStart && !this.isRecycling) {
      debugWorker('trying to recycle worker [' + this.id + '], reason: process exit..');

      this.exit = true;
      this.firstStart = false;

      this.recycle(function () {
        _this.exit = false;
      });
    }
  };

  ElectronWorker.prototype.onWorkerProcessIpcMessage = function onWorkerProcessIpcMessage(payload) {
    var callback = undefined,
        responseData = undefined;

    if (payload && payload.workerEvent === 'taskResponse') {
      debugWorker('task in worker [' + this.id + '] has ended..');

      callback = this._taskCallback[payload.taskId];
      responseData = payload.response;

      if (!callback || typeof callback !== 'function') {
        debugWorker('worker [' + this.id + '] - callback registered for the task\'s response (' + payload.taskId + ') is not a function');
        return;
      }

      if (payload.error) {
        var errorSerialized = JSON.stringify(payload.error);

        debugWorker('task in worker [' + this.id + '] ended with error: ' + errorSerialized);

        return callback(new Error(payload.error.message || 'An error has occurred when trying to process the task: ' + errorSerialized));
      }

      debugWorker('task in worker [' + this.id + '] ended successfully');

      callback(null, responseData);
    }
  };

  ElectronWorker.prototype.start = function start(cb) {
    var _this2 = this;

    var isDone = false;

    if (!isValidConnectionMode(this.options.connectionMode)) {
      return cb(new Error('invalid connection mode: ' + this.options.connectionMode));
    }

    debugWorker('starting worker [' + this.id + ']..');

    this.findFreePort(function (err, port) {
      var childArgs = undefined,
          childOpts = undefined;

      var _options = _this2.options;
      var electronArgs = _options.electronArgs;
      var pathToElectron = _options.pathToElectron;
      var pathToScript = _options.pathToScript;
      var hostEnvVarName = _options.hostEnvVarName;
      var portEnvVarName = _options.portEnvVarName;
      var host = _options.host;
      var debug = _options.debug;
      var debugBrk = _options.debugBrk;
      var env = _options.env;
      var stdio = _options.stdio;
      var connectionMode = _options.connectionMode;

      if (!env) {
        env = {};
      }

      childArgs = electronArgs.slice();
      childArgs.unshift(pathToScript);

      if (debugBrk != null) {
        childArgs.unshift('--debug-brk=' + debugBrk);
      } else if (debug != null) {
        childArgs.unshift('--debug=' + debug);
      }

      if (err) {
        debugWorker('couldn\'t find free port for worker [' + _this2.id + ']..');
        return cb(err);
      }

      _this2.port = port;

      childOpts = {
        env: _extends({}, env, {
          ELECTRON_WORKER_ID: _this2.id,
          // propagate the DISPLAY env var to make it work on LINUX
          DISPLAY: process.env.DISPLAY
        })
      };

      // we send host and port as env vars to child process in server mode
      if (connectionMode === 'server') {
        childOpts.stdio = 'pipe';
        childOpts.env[hostEnvVarName] = host;
        childOpts.env[portEnvVarName] = port;
      } else if (connectionMode === 'ipc') {
        childOpts.stdio = ['pipe', 'pipe', 'pipe', 'ipc'];
      }

      if (stdio != null) {
        childOpts.stdio = stdio;
      }

      debugWorker('spawning process for worker [' + _this2.id + '] with args:', childArgs, 'and options:', childOpts);

      _this2._childProcess = _child_process2['default'].spawn(pathToElectron, childArgs, childOpts);

      debugWorker('electron process pid for worker [' + _this2.id + ']:', _this2._childProcess.pid);

      // ipc connection is required for ipc mode
      if (connectionMode === 'ipc' && !_this2._childProcess.send) {
        return cb(new Error('ipc mode requires a ipc connection, if you\'re using stdio option make sure you are setting up ipc'));
      }

      _this2._handleSpawnError = function (spawnError) {
        debugWorker('worker [' + this.id + '] spawn error callback..');

        if (!this.firstStart) {
          isDone = true;
          this._earlyError = true;
          debugWorker('worker [' + this.id + '] start was canceled because an early error: ' + spawnError.message);
          cb(spawnError);
        }
      };

      _this2._handleSpawnError = _this2._handleSpawnError.bind(_this2);

      _this2._childProcess.once('error', _this2._handleSpawnError);

      _this2._childProcess.on('error', _this2.onWorkerProcessError);

      _this2._childProcess.on('exit', _this2.onWorkerProcessExitTryToRecyle);

      if (connectionMode === 'ipc') {
        _this2._childProcess.on('message', _this2.onWorkerProcessIpcMessage);
      }

      _this2.emit('processCreated');

      setImmediate(function () {
        // the workers were killed explicitly by the user
        if (_this2._hardKill || isDone) {
          return;
        }

        if (_this2._childProcess == null) {
          debugWorker('There is no child process for worker [' + _this2.id + ']..');
          return cb(new Error('There is no child process for worker'));
        }

        debugWorker('checking if worker [' + _this2.id + '] is alive..');

        _this2.checkAlive(function (checkAliveErr) {
          if (isDone) {
            return;
          }

          if (checkAliveErr) {
            debugWorker('worker [' + _this2.id + '] is not alive..');
            return cb(checkAliveErr);
          }

          _this2._earlyError = false;
          _this2._childProcess.removeListener('error', _this2._handleSpawnError);

          if (!_this2.firstStart) {
            _this2.firstStart = true;
          }

          debugWorker('worker [' + _this2.id + '] is alive..');
          cb();
        });
      });
    });
  };

  ElectronWorker.prototype.checkAlive = function checkAlive(cb, shot) {
    var shotCount = shot || 1,
        connectionMode = this.options.connectionMode;

    function statusHandler(err, statusWorker) {
      var _this3 = this;

      if (!err && statusWorker === 'open') {
        return cb();
      }

      if (connectionMode === 'server' && shotCount > 50) {
        return cb(new Error('Unable to reach electron worker - mode: ' + connectionMode + ', ' + (err || {}).message));
      }

      if (connectionMode === 'ipc' && err) {
        return cb(err);
      }

      shotCount++;

      // re-try check
      if (connectionMode === 'server') {
        setTimeout(function () {
          _this3.checkAlive(cb, shotCount);
        }, 100);
      }
    }

    if (connectionMode === 'server') {
      _checkPortStatus2['default'](this.options.pingTimeout, this.port, this.options.host, statusHandler.bind(this));
    } else if (connectionMode === 'ipc') {
      _checkIpcStatus2['default'](this.options.pingTimeout, this._childProcess, statusHandler.bind(this));
    }
  };

  ElectronWorker.prototype.execute = function execute(data, cb) {
    var _this4 = this;

    var connectionMode = this.options.connectionMode,
        httpOpts = undefined,
        req = undefined,
        json = undefined,
        taskId = undefined;

    debugWorker('new task for worker [' + this.id + ']..');

    this.emit('task');

    if (this._hardKill) {
      debugWorker('task execution stopped because worker [' + this.id + '] was killed by the user..');
      return;
    }

    if (connectionMode === 'ipc') {
      debugWorker('creating ipc task message for worker [' + this.id + ']..');

      taskId = _uuid2['default'].v1();

      this._taskCallback[taskId] = function () {
        for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
          args[_key] = arguments[_key];
        }

        _this4.emit('taskEnd');
        cb.apply(undefined, args);
      };

      return this._childProcess.send({
        workerEvent: 'task',
        taskId: taskId,
        payload: data
      });
    }

    debugWorker('creating request for worker [' + this.id + ']..');

    httpOpts = {
      hostname: this.options.host,
      port: this.port,
      path: '/',
      method: 'POST'
    };

    req = _http2['default'].request(httpOpts, function (res) {
      var result = '';

      res.on('data', function (chunk) {
        result += chunk;
      });

      res.on('end', function () {
        var responseData = undefined;

        debugWorker('request in worker [' + _this4.id + '] has ended..');

        _this4.emit('taskEnd');

        try {
          debugWorker('trying to parse worker [' + _this4.id + '] response..');
          responseData = result ? JSON.parse(result) : null;
        } catch (err) {
          debugWorker('couldn\'t parse response for worker [' + _this4.id + ']..');
          return cb(err);
        }

        debugWorker('response has been parsed correctly for worker [' + _this4.id + ']..');
        cb(null, responseData);
      });
    });

    req.setHeader('Content-Type', 'application/json');
    json = JSON.stringify(data);
    req.setHeader('Content-Length', Buffer.byteLength(json));

    debugWorker('trying to communicate with worker [' + this.id + '], request options:', httpOpts, 'data:', json);

    req.write(json);

    req.on('error', function (err) {
      debugWorker('error when trying to communicate with worker [' + _this4.id + ']..');
      cb(err);
    });

    req.end();
  };

  ElectronWorker.prototype.recycle = function recycle() {
    var _this5 = this;

    var cb = undefined,
        revive = undefined;

    debugWorker('recycling worker [' + this.id + ']..');

    for (var _len2 = arguments.length, args = Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
      args[_key2] = arguments[_key2];
    }

    if (args.length < 2) {
      cb = args[0];
      revive = true;
    } else {
      cb = args[1];
      revive = args[0];
    }

    if (this._childProcess) {
      this.isRecycling = true;
      // mark worker as busy before recycling
      this.isBusy = true;

      this.emit('recycling');

      if (this._hardKill) {
        debugWorker('recycling was stopped because worker [' + this.id + '] was killed by the user..');
        return;
      }

      this.kill();

      debugWorker('trying to re-start child process for worker [' + this.id + ']..');

      this.start(function (startErr) {
        _this5.isRecycling = false;
        // mark worker as free after recycling
        _this5.isBusy = false;

        // if there is a error on worker recycling, revive it on next execute
        if (startErr) {
          _this5.shouldRevive = Boolean(revive);

          debugWorker('couldn\'t recycle worker [' + _this5.id + '], should revive: ' + _this5.shouldRevive);

          cb(startErr);
          _this5.emit('recyclingError', startErr);
          return;
        }

        debugWorker('worker [' + _this5.id + '] has been recycled..');

        _this5.shouldRevive = false;

        cb();

        _this5.emit('recycled');
      });
    } else {
      debugWorker('there is no child process to recycle - worker [' + this.id + ']');
    }
  };

  ElectronWorker.prototype.kill = function kill(hardKill) {
    var connectionMode = this.options.connectionMode;

    debugWorker('killing worker [' + this.id + ']..');

    this.emit('kill');

    this._hardKill = Boolean(hardKill);

    if (this._childProcess) {
      if (this._childProcess.connected) {
        debugWorker('closing ipc connection - worker [' + this.id + ']..');
        this._childProcess.disconnect();
      }

      // clean previous listeners
      if (this._handleSpawnError) {
        this._childProcess.removeListener('error', this._handleSpawnError);
      }

      this._childProcess.removeListener('error', this.onWorkerProcessError);
      this._childProcess.removeListener('exit', this.onWorkerProcessExitTryToRecyle);

      if (connectionMode === 'ipc') {
        this._childProcess.removeListener('message', this.onWorkerProcessIpcMessage);
      }

      // guard against closing a process that has been closed before
      if (!this.exit) {
        if (this.options.killSignal) {
          debugWorker('killing worker [' + this.id + '] with custom signal:', this.options.killSignal);
          this._childProcess.kill(this.options.killSignal);
        } else {
          this._childProcess.kill();
        }

        if (!hardKill) {
          this.onWorkerProcessExitTryToRecyle();
        }
      }

      this._childProcess = undefined;
    } else {
      debugWorker('there is no child process to kill - worker [' + this.id + ']');
    }
  };

  return ElectronWorker;
})(_events.EventEmitter);

exports['default'] = ElectronWorker;
module.exports = exports['default'];