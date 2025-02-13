
/**
 * ElectronManager is responsible of managing pool of electron worker processes
 * and distributing tasks to them.
 */

'use strict';

exports.__esModule = true;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _inherits(subClass, superClass) { if (typeof superClass !== 'function' && superClass !== null) { throw new TypeError('Super expression must either be null or a function, not ' + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var _events = require('events');

var _os = require('os');

var _os2 = _interopRequireDefault(_os);

var _debug = require('debug');

var _debug2 = _interopRequireDefault(_debug);

var _which = require('which');

var _which2 = _interopRequireDefault(_which);

var _lodashFindindex = require('lodash.findindex');

var _lodashFindindex2 = _interopRequireDefault(_lodashFindindex);

var _ElectronWorker = require('./ElectronWorker');

var _ElectronWorker2 = _interopRequireDefault(_ElectronWorker);

var _packageJson = require('../package.json');

var numCPUs = _os2['default'].cpus().length,
    debugManager = _debug2['default'](_packageJson.name + ':manager');

var ELECTRON_PATH = undefined;

function getElectronPath() {
  var electron = undefined;

  if (ELECTRON_PATH) {
    debugManager('getting electron path from cache');
    return ELECTRON_PATH;
  }

  // first try to find the electron executable if it is installed from `electron`..
  electron = getElectronPathFromPackage('electron');

  if (electron == null) {
    // second try to find the electron executable if it is installed from `electron-prebuilt`..
    electron = getElectronPathFromPackage('electron-prebuilt');
  }

  if (electron == null) {
    // last try to find the electron executable, trying using which module
    debugManager('trying to get electron path from $PATH..');

    try {
      electron = _which2['default'].sync('electron');
    } catch (whichErr) {
      throw new Error('Couldn\'t find the path to the electron executable automatically, ' + 'try installing the `electron` or `electron-prebuilt` package, ' + 'or set the `pathToElectron` option to specify the path manually');
    }
  }

  ELECTRON_PATH = electron;

  return electron;
}

function getElectronPathFromPackage(moduleName) {
  var electronPath = undefined;

  try {
    debugManager('trying to get electron path from "' + moduleName + '" module..');

    // eslint-disable-next-line global-require
    electronPath = require(moduleName);

    return electronPath;
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return electronPath;
    }

    throw err;
  }
}

var ElectronManager = (function (_EventEmitter) {
  _inherits(ElectronManager, _EventEmitter);

  function ElectronManager() {
    var options = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];

    _classCallCheck(this, ElectronManager);

    _EventEmitter.call(this);

    var instance = this;

    this._electronInstances = [];
    this._electronInstancesTasksCount = {};
    this.options = _extends({}, options);
    this.options.connectionMode = this.options.connectionMode || 'server';
    this.options.electronArgs = this.options.electronArgs || [];
    this.options.pathToElectron = this.options.pathToElectron || getElectronPath();
    this.options.numberOfWorkers = this.options.numberOfWorkers || numCPUs;
    this.options.maxConcurrencyPerWorker = this.options.maxConcurrencyPerWorker || Infinity;
    this.options.pingTimeout = this.options.pingTimeout || 100;
    this.options.timeout = this.options.timeout || 10000;
    this.options.host = this.options.host || 'localhost';
    this.options.hostEnvVarName = this.options.hostEnvVarName || 'ELECTRON_WORKER_HOST';
    this.options.portEnvVarName = this.options.portEnvVarName || 'ELECTRON_WORKER_PORT';
    this._timeouts = [];
    this.tasksQueue = [];

    if (isNaN(this.options.maxConcurrencyPerWorker) || typeof this.options.maxConcurrencyPerWorker !== 'number') {
      throw new Error('`maxConcurrencyPerWorker` option must be a number');
    }

    if (this.options.maxConcurrencyPerWorker <= 0) {
      throw new Error('`maxConcurrencyPerWorker` option must be greater than 0');
    }

    function processExitHandler() {
      debugManager('process exit: trying to kill workers..');
      instance.kill();
    }

    this._processExitHandler = processExitHandler;

    process.once('exit', processExitHandler);
  }

  ElectronManager.prototype.start = function start(cb) {
    var _this = this;

    var started = 0;
    var workerErrors = [];
    var _options = this.options;
    var numberOfWorkers = _options.numberOfWorkers;
    var connectionMode = _options.connectionMode;
    var couldNotStartWorkersErr = undefined;

    if (connectionMode !== 'server' && connectionMode !== 'ipc') {
      return cb(new Error('invalid connection mode: ' + connectionMode));
    }

    debugManager('starting ' + numberOfWorkers + ' worker(s), mode: ' + connectionMode + '..');

    function startHandler(err) {
      if (err) {
        workerErrors.push(err);
      }

      started++;

      if (started === numberOfWorkers) {
        if (workerErrors.length) {
          couldNotStartWorkersErr = new Error('electron manager could not start all workers..');
          couldNotStartWorkersErr.workerErrors = workerErrors;
          debugManager('electron manager could not start all workers..');
          return cb(couldNotStartWorkersErr);
        }

        debugManager('all workers started correctly');
        cb(null);
      }
    }

    var _loop = function (ix) {
      var workerPortLeftBoundary = _this.options.portLeftBoundary,
          workerOptions = undefined,
          workerInstance = undefined;

      // prevent that workers start with the same left boundary
      if (workerPortLeftBoundary != null) {
        workerPortLeftBoundary += ix;
      }

      workerOptions = {
        debug: _this.options.debug,
        debugBrk: _this.options.debugBrk,
        env: _this.options.env,
        stdio: _this.options.stdio,
        connectionMode: _this.options.connectionMode,
        pingTimeout: _this.options.pingTimeout,
        killSignal: _this.options.killSignal,
        electronArgs: _this.options.electronArgs,
        pathToElectron: _this.options.pathToElectron,
        pathToScript: _this.options.pathToScript,
        hostEnvVarName: _this.options.hostEnvVarName,
        portEnvVarName: _this.options.portEnvVarName,
        host: _this.options.host,
        portLeftBoundary: workerPortLeftBoundary,
        portRightBoundary: _this.options.portRightBoundary
      };

      debugManager('creating worker ' + (ix + 1) + ' with options:', workerOptions);
      workerInstance = new _ElectronWorker2['default'](workerOptions);

      workerInstance.on('processCreated', function () {
        _this.emit('workerProcessCreated', workerInstance, workerInstance._childProcess);
      });

      workerInstance.on('recycling', function () {
        if (_this._electronInstancesTasksCount[workerInstance.id] != null) {
          _this._electronInstancesTasksCount[workerInstance.id] = 0;
        }

        _this.emit('workerRecycling', workerInstance);
      });

      workerInstance.on('recyclingError', function () {
        _this.emit('workerRecyclingError', workerInstance);
        _this.tryFlushQueue();
      });

      workerInstance.on('recycled', function () {
        _this.emit('workerRecycled', workerInstance);
        _this.tryFlushQueue();
      });

      workerInstance.on('kill', function () {
        if (_this._electronInstancesTasksCount[workerInstance.id] != null) {
          _this._electronInstancesTasksCount[workerInstance.id] = 0;
        }
      });

      _this._electronInstances.push(workerInstance);
      _this._electronInstancesTasksCount[workerInstance.id] = 0;

      _this._electronInstances[ix].start(startHandler);
    };

    for (var ix = 0; ix < numberOfWorkers; ix++) {
      _loop(ix);
    }
  };

  ElectronManager.prototype.execute = function execute(data) {
    var availableWorkerInstanceIndex = undefined,
        availableWorkerInstance = undefined,
        options = undefined,
        cb = undefined;

    for (var _len = arguments.length, args = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
      args[_key - 1] = arguments[_key];
    }

    if (args.length > 1) {
      options = args[0];
      cb = args[1];
    } else {
      cb = args[0];
    }

    debugManager('getting new task..');

    // simple round robin balancer across workers
    // on each execute, get the first available worker from the list...
    availableWorkerInstanceIndex = _lodashFindindex2['default'](this._electronInstances, {
      isBusy: false
    });

    if (availableWorkerInstanceIndex !== -1) {
      availableWorkerInstance = this._electronInstances.splice(availableWorkerInstanceIndex, 1)[0];

      this._manageTaskStartInWorker(availableWorkerInstance);

      debugManager('worker [' + availableWorkerInstance.id + '] has been choosen for the task..');

      this._executeInWorker(availableWorkerInstance, data, options, cb);
      // ..and then the worker we have used becomes the last item in the list
      this._electronInstances.push(availableWorkerInstance);
      return;
    }

    debugManager('no workers available, storing the task for later processing..');
    // if no available worker save task for later processing
    this.tasksQueue.push({ data: data, options: options, cb: cb });
  };

  ElectronManager.prototype._manageTaskStartInWorker = function _manageTaskStartInWorker(worker) {
    var maxConcurrencyPerWorker = this.options.maxConcurrencyPerWorker;

    if (this._electronInstancesTasksCount[worker.id] == null) {
      this._electronInstancesTasksCount[worker.id] = 0;
    }

    if (this._electronInstancesTasksCount[worker.id] < maxConcurrencyPerWorker) {
      this._electronInstancesTasksCount[worker.id]++;
    }

    // "equality check" is just enough here but we apply the "greater than" check just in case..
    if (this._electronInstancesTasksCount[worker.id] >= maxConcurrencyPerWorker) {
      worker.isBusy = true; // eslint-disable-line no-param-reassign
    }
  };

  ElectronManager.prototype._manageTaskEndInWorker = function _manageTaskEndInWorker(worker) {
    var maxConcurrencyPerWorker = this.options.maxConcurrencyPerWorker;

    if (this._electronInstancesTasksCount[worker.id] == null) {
      this._electronInstancesTasksCount[worker.id] = 0;
    }

    if (this._electronInstancesTasksCount[worker.id] > 0) {
      this._electronInstancesTasksCount[worker.id]--;
    }

    if (this._electronInstancesTasksCount[worker.id] < maxConcurrencyPerWorker) {
      worker.isBusy = false; // eslint-disable-line no-param-reassign
    }
  };

  ElectronManager.prototype._executeInWorker = function _executeInWorker(worker, data, options, cb) {
    var _this2 = this;

    if (options === undefined) options = {};

    var workerTimeout = undefined;

    if (options.timeout != null) {
      workerTimeout = options.timeout;
    } else {
      workerTimeout = this.options.timeout;
    }

    if (worker.shouldRevive && this.options.shouldRevive) {
      debugManager('trying to revive worker [' + worker.id + ']..');

      worker.start(function (startErr) {
        if (startErr) {
          debugManager('worker [' + worker.id + '] could not revive..');
          _this2.tryFlushQueue();
          return cb(startErr);
        }

        debugManager('worker [' + worker.id + '] has revived..');
        executeTask.call(_this2);
      });
    } else {
      executeTask.call(this);
    }

    function executeTask() {
      var _this3 = this;

      var isDone = false;

      var timeoutId = setTimeout(function () {
        _this3._timeouts.splice(_this3._timeouts.indexOf(timeoutId), 1);

        if (isDone) {
          return;
        }

        debugManager('task timeout in worker [' + worker.id + '] has been reached..');

        isDone = true;

        _this3._manageTaskEndInWorker(worker);

        _this3.emit('workerTimeout', worker);

        var error = new Error();
        error.workerTimeout = true;
        error.message = 'Worker Timeout, the worker process does not respond after ' + workerTimeout + ' ms';
        cb(error);

        _this3.tryFlushQueue();
      }, workerTimeout);

      debugManager('executing task in worker [' + worker.id + '] with timeout:', workerTimeout);

      this._timeouts.push(timeoutId);

      worker.execute(data, function (err, result) {
        if (isDone) {
          return;
        }

        _this3._manageTaskEndInWorker(worker);

        // clear timeout
        _this3._timeouts.splice(_this3._timeouts.indexOf(timeoutId), 1);
        clearTimeout(timeoutId);

        if (err) {
          debugManager('task has failed in worker [' + worker.id + ']..');
          _this3.tryFlushQueue();
          cb(err);
          return;
        }

        isDone = true;
        debugManager('task executed correctly in worker [' + worker.id + ']..');
        _this3.tryFlushQueue();
        cb(null, result);
      });
    }
  };

  ElectronManager.prototype.tryFlushQueue = function tryFlushQueue() {
    var availableWorkerInstanceIndex = undefined,
        availableWorkerInstance = undefined,
        task = undefined;

    debugManager('trying to flush queue of pending tasks..');

    if (this.tasksQueue.length === 0) {
      debugManager('there is no pending tasks..');
      return;
    }

    // simple round robin balancer across workers
    // get the first available worker from the list...
    availableWorkerInstanceIndex = _lodashFindindex2['default'](this._electronInstances, {
      isBusy: false
    });

    if (availableWorkerInstanceIndex === -1) {
      debugManager('no workers available to process pending task..');
      return;
    }

    task = this.tasksQueue.shift();
    availableWorkerInstance = this._electronInstances.splice(availableWorkerInstanceIndex, 1)[0];

    this._manageTaskStartInWorker(availableWorkerInstance);

    debugManager('worker [' + availableWorkerInstance.id + '] has been choosen for process pending task..');

    this._executeInWorker(availableWorkerInstance, task.data, task.options, task.cb);
    // ..and then the worker we have used becomes the last item in the list
    this._electronInstances.push(availableWorkerInstance);
  };

  ElectronManager.prototype.kill = function kill() {
    debugManager('killing all workers..');

    this._timeouts.forEach(function (tId) {
      clearTimeout(tId);
    });

    this._electronInstances.forEach(function (workerInstance) {
      workerInstance.kill(true);
    });

    process.removeListener('exit', this._processExitHandler);
  };

  return ElectronManager;
})(_events.EventEmitter);

exports['default'] = ElectronManager;
module.exports = exports['default'];