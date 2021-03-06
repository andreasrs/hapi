// Load modules

var Url = require('url');
var Async = require('async');
var Boom = require('boom');
var Utils = require('./utils');
var Response = require('./response');
var Ext = require('./ext');
var Handler = require('./handler');
var Views = require('./views');


// Declare internals

var internals = {};


exports = module.exports = internals.Request = function (server, req, res, options) {

    var self = this;

    // Take measurement as soon as possible

    this._bench = new Utils.Bench();
    var now = Date.now();

    // Public members

    this.server = server;
    this.hapi = require('./');

    this.url = null;
    this.query = null;
    this.path = null;
    this.method = null;
    this.mime = null;                       // Set if payload is parsed

    this.setUrl = this._setUrl;             // Decoration removed after 'onRequest'
    this.setMethod = this._setMethod;

    this.setUrl(req.url);                   // Sets: this.url, this.path, this.query
    this.setMethod(req.method);             // Sets: this.method
    this.headers = req.headers;

    this.id = now + '-' + process.pid + '-' + Math.floor(Math.random() * 0x10000);

    this.app = {};                          // Place for application-specific state without conflicts with hapi, should not be used by plugins
    this.plugins = {};                      // Place for plugins to store state without conflicts with hapi, should be namespaced using plugin name

    this._route = this.server._router.notfound;             // Used prior to routing (only settings are used, not the handler)
    this.route = this._route.settings;

    this.auth = {
        isAuthenticated: false,
        credentials: null,                  // Special keys: 'app', 'user', 'scope', 'tos'
        artifacts: null,                    // Scheme-specific artifacts
        session: null                       // Used by cookie auth { set(), clear() }
    };

    this.session = null;                    // Special key reserved for plugins implementing session support

    this.pre = {};                          // Pre raw values
    this.responses = {};                    // Pre response values

    this.info = {
        received: now,
        remoteAddress: (req.connection && req.connection.remoteAddress) || '',
        remotePort: (req.connection && req.connection.remotePort) || '',
        referrer: req.headers.referrer || req.headers.referer || '',
        host: req.headers.host ? req.headers.host.replace(/\s/g, '') : ''
    };

    // Apply options

    if (options.credentials) {
        this.auth.credentials = options.credentials;
    }

    // Defined elsewhere:

    this.params = null;
    this.rawPayload = null;
    this.payload = null;
    this.state = null;
    this.jsonp = null;
    this.response = null;       // this.response()

    // Semi-public members

    this.raw = {
        req: req,
        res: res
    };

    this.setState = this._setState;                 // Remove once replied
    this.clearState = this._clearState;             // Remove once replied
    this.tail = this.addTail = this._addTail;       // Removed once wagging

    // Private members

    this._states = {};                  // Appended to response states when setting response headers
    this._logger = [];

    this._response = null;
    this._isReplied = false;

    this._tails = {};                   // tail id -> name (tracks pending tails)
    this._tailIds = 0;                  // Used to generate a unique tail id
    this._isWagging = false;            // true when request completed and only waiting on tails to complete

    this._paramsArray = [];             // Array of path parameters in path order

    this._pluginEnv = undefined;        // Set to the plugin env when ext methods are invoked

    // Set socket timeout

    if (req.socket &&
        server.settings.timeout.socket !== undefined) {

        req.socket.setTimeout(server.settings.timeout.socket || 0);
    }

    // Listen to request errors

    this._onClose = function () {

        self.log(['hapi', 'request', 'error', 'closed']);
    };

    this.raw.req.once('close', this._onClose);

    this._onError = function (err) {

        self.log(['hapi', 'request', 'error'], err);
    };

    this.raw.req.once('error', this._onError);

    this._onAborted = function () {

        self.log(['hapi', 'request', 'error', 'aborted']);
    };

    this.raw.req.once('aborted', this._onAborted);

    // Log request

    var about = {
        id: this.id,
        method: this.method,
        url: this.url.href,
        agent: this.raw.req.headers['user-agent']
    };

    this.log(['hapi', 'received'], about, now);     // Must be last for object to be fully constructed
};


internals.Request.prototype._setUrl = function (url) {

    this.url = Url.parse(url, true);
    this.query = this.url.query || {};
    this.path = this.url.pathname;          // pathname excludes query

    if (this.path &&
        this.server.settings.router.normalizeRequestPath) {

        // Uppercase %encoded values

        var uppercase = this.path.replace(/%[0-9a-fA-F][0-9a-fA-F]/g, function (encoded) {

            return encoded.toUpperCase();
        });

        // Decode non-reserved path characters: a-z A-Z 0-9 _!$&'()*+,;=:@-.~
        // ! (%21) $ (%24) & (%26) ' (%27) ( (%28) ) (%29) * (%2A) + (%2B) , (%2C) - (%2D) . (%2E)
        // 0-9 (%30-39) : (%3A) ; (%3B) = (%3D)
        // @ (%40) A-Z (%41-5A) _ (%5F) a-z (%61-7A) ~ (%7E)

        var decoded = uppercase.replace(/%(?:2[146-9A-E]|3[\dABD]|4[\dA-F]|5[\dAF]|6[1-9A-F]|7[\dAE])/g, function (encoded) {

            return String.fromCharCode(parseInt(encoded.substring(1), 16));
        });

        this.path = decoded;
    }
};


internals.Request.prototype._setMethod = function (method) {

    if (method) {
        this.method = method.toLowerCase();
    }
};


internals.Request.prototype.log = function (tags, data, timestamp) {

    tags = (Array.isArray(tags) ? tags : [tags]);

    // Prepare log item

    var now = (timestamp ? (timestamp instanceof Date ? timestamp.getTime() : timestamp) : Date.now());
    var item = {
        request: this.id,
        timestamp: now,
        tags: tags
    };

    var tagsMap = Utils.mapToObject(item.tags);

    if (data) {
        if (data instanceof Error) {
            item.data = (data.isBoom ? data.decorations() : {});
            item.data.message = data.message;
            if (tagsMap.uncaught) {
                item.data.trace = data.stack;
            }
        }
        else {
            item.data = data;
        }
    }

    // Add to request array

    this._logger.push(item);
    this.server.emit('request', this, item, tagsMap);

    if (this.server.settings.debug &&
        this.server.settings.debug.request &&
        Utils.intersect(tagsMap, this.server.settings.debug.request, true)) {

        console.error('Debug:', item.tags.join(', '), data ? (data.stack || data) : '');
    }
};


internals.Request.prototype.getLog = function (tags) {

    tags = [].concat(tags || []);
    if (!tags.length) {
        return this._logger;
    }

    var filter = Utils.mapToObject(tags);
    var result = [];

    for (var i = 0, il = this._logger.length; i < il; ++i) {
        var event = this._logger[i];
        for (var t = 0, tl = event.tags.length; t < tl; ++t) {
            var tag = event.tags[t];
            if (filter[tag]) {
                result.push(event);
            }
        }
    }

    return result;
};


internals.Request.prototype._execute = function () {

    var self = this;

    // Execute onRequest extensions (can change request method and url)

    this.server._ext.invoke(this, 'onRequest', function (err) {

        // Undecorate request

        self.setUrl = undefined;
        self.setMethod = undefined;

        if (err) {
            self._reply(err);
            return;
        }

        if (!self.path || self.path[0] !== '/') {
            self._reply(Boom.badRequest('Invalid path'));
            return;
        }

        // Lookup route

        self._route = self.server._router.route(self);
        self.route = self._route.settings;

        // Setup timer

        var serverTimeout = self.server.settings.timeout.server;
        if (serverTimeout) {
            serverTimeout -= self._bench.elapsed();                 // Calculate the timeout from when the request was constructed
            var timeoutReply = function () {

                self._reply(Boom.serverTimeout());
            };

            if (serverTimeout <= 0) {
                return timeoutReply();
            }

            self._serverTimeoutId = setTimeout(timeoutReply, serverTimeout);
        }

        Async.forEachSeries(self._route.cycle, function (func, next) {

            if (self._isReplied) {
                self.log(['hapi', 'server', 'timeout']);
                return next(true);                                  // Argument is ignored but aborts the series
            }

            if (typeof func === 'string') {
                self.server._ext.invoke(self, func, next);
                return;
            }

            func(self, next);

        },
        function (err) {

            self._reply(err);
        });
    });
};


internals.Request.prototype._reply = function (exit) {

    var self = this;

    if (this._isReplied) {                                      // Prevent any future responses to this request
        return;
    }

    this._isReplied = true;

    clearTimeout(this._serverTimeoutId);

    self.setState = undefined;
    self.clearState = undefined;

    var process = function () {

        if (self._response &&
            self._response.closed) {

            self.raw.res.end();                                 // End the response in case it wasn't already closed
            return Utils.nextTick(finalize)();
        }

        if (exit) {
            self._setResponse(Handler.response(exit, self));
        }

        self.server._ext.invoke(self, 'onPreResponse', function (err) {

            self.response = undefined;

            if (err) {                                         // err can be valid response or error
                self._setResponse(Handler.response(err, self));
            }

            Response.send(self._response, self, finalize);
        });
    };

    var finalize = function () {

        self.server._dtrace.report('request.finalize', self._response);
        if (self._response &&
            self._response._err &&
            self._response.statusCode === 500) {

            var error = self._response._err;
            self.server.emit('internalError', self, error);
            self.log(error.isDeveloperError ? ['hapi', 'internal', 'implementation', 'error'] : ['hapi', 'internal', 'error'], error);
        }

        self.server.emit('response', self);

        self._isWagging = true;
        self.addTail = undefined;
        self.tail = undefined;

        if (Object.keys(self._tails).length === 0) {
            self.server.emit('tail', self);
        }

        self._cleanup();
    };

    process();
};


internals.Request.prototype._cleanup = function () {

    this.raw.req.removeListener('close', this._onClose);
    this.raw.req.removeListener('error', this._onError);
    this.raw.req.removeListener('aborted', this._onAborted);
};


internals.Request.parseJSONP = function (request, next) {

    var jsonp = request.query[request.route.jsonp];
    if (jsonp) {
        if (!jsonp.match(/^[\w\$\[\]\.]+$/)) {
            return next(Boom.badRequest('Invalid JSONP parameter value'));
        }

        request.jsonp = jsonp;
        delete request.query[request.route.jsonp];
    }

    return next();
};


internals.Request.prototype._setResponse = function (response) {

    var self = this;

    this._response = response;
    this.response = this.response || function () {

        return self._response;
    };
};


internals.Request.prototype._addTail = function (name) {

    var self = this;

    name = name || 'unknown';
    var tailId = this._tailIds++;
    this._tails[tailId] = name;
    this.log(['hapi', 'tail', 'add'], { name: name, id: tailId });

    var drop = function () {

        if (!self._tails[tailId]) {
            self.log(['hapi', 'tail', 'remove', 'error'], { name: name, id: tailId });             // Already removed
            return;
        }

        delete self._tails[tailId];

        if (Object.keys(self._tails).length === 0 &&
            self._isWagging) {

            self.log(['hapi', 'tail', 'remove', 'last'], { name: name, id: tailId });
            self.server.emit('tail', self);
        }
        else {
            self.log(['hapi', 'tail', 'remove'], { name: name, id: tailId });
        }
    };

    return drop;
};


internals.Request.prototype._setState = function (name, value, options) {

    if (this._response &&
        this._response.state) {

        this._response.state(name, value, options);
    }
    else {
        Response.Plain.prototype.state.call(this, name, value, options);
    }
};


internals.Request.prototype._clearState = function (name) {

    if (this._response &&
        this._response.unstate) {

        this._response.unstate(name);
    }
    else {
        Response.Plain.prototype.unstate.call(this, name);
    }
};


internals.Request.prototype.generateResponse = function (result) {

    return Handler.response(result, this);
};


internals.Request.prototype.generateView = function (template, context, options) {

    var viewsManager = (this._pluginEnv ? this._pluginEnv.views : this._route.env.views) || this.server._views;
    Utils.assert(viewsManager, 'Cannot generate view without a views manager initialized');
    return Handler.response(new Views.Response(viewsManager, template, context, options));
};

