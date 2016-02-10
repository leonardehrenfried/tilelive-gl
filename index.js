var sm = new (require('sphericalmercator'))();
var mbgl = require('mapbox-gl-native');
var Png = require('png').Png;
var vtpbf = require('vt-pbf');
var stream = require('stream');
var concat = require('concat-stream');
var request = require('request');
var url = require('url');
var fs = require('fs');
var Pool = require('generic-pool').Pool;
var N_CPUS = require('os').cpus().length;

mbgl.on('message', function(msg) {
  console.log(msg);
});

function pool(style, options) {
    return Pool({
        create: create,
        destroy: destroy,
        max: N_CPUS
    });

    function create(callback) {
        var map = new mbgl.Map(options);
        var loaded = map.load(style);
        return callback(null, map);
    }

    function destroy(map) {
        delete map;
    }
}

function mbglRequest(req, callback){
    var opts = {
        url: req.url,
        encoding: null,
        gzip: true
    };

    var uri = url.parse(req.url)

    if (uri.protocol === 'file:') {
        fs.readFile(decodeURI(uri.hostname + uri.pathname), function(err, data) {
            if (err) {
                callback(err);
            } else {
                var response = {};
                response.data = data
                callback(null, response)
            }
        })
    } else {
      request(opts, function (err, res, body) {
          if (err) {
              //TODO: temporary hack to fix zero-size protobufs
              if (err.code === "Z_BUF_ERROR") {
                  callback(null, {data: new Buffer(0)})
              } else {
                  console.error(err, opts)
                  callback(err);
              }
          } else if (res == undefined) {
              callback(null, {data: new Buffer(0)})
          } else if (res.statusCode == 200) {
              var response = {};

              if (res.headers.modified) { response.modified = new Date(res.headers.modified); }
              if (res.headers.expires) { response.expires = new Date(res.headers.expires); }
              if (res.headers.etag) { response.etag = res.headers.etag; }

              response.data = body;

              callback(null, response);
          } else if (res.statusCode == 404) {
              var response = {}

              if (res.headers.modified) { response.modified = new Date(res.headers.modified); }
              if (res.headers.expires) { response.expires = new Date(res.headers.expires); }
              if (res.headers.etag) { response.etag = res.headers.etag; }

              response.data = new Buffer(0);

              callback(null, response)
          } else {
              callback(new Error(body));
          }
      });
    }
}

function GL(options, callback) {
    if (!options || (typeof options !== 'object' && typeof options !== 'string')) return callback(new Error('options must be an object or a string'));
    if (!options.style) return callback(new Error('Missing GL style JSON'));

    this._scale = options.query.scale || 1;

    this._pool = pool(options.style, {
      request: mbglRequest,
      ratio: this._scale
    });

    return callback(null, this);
}

GL.registerProtocols = function(tilelive) {
    tilelive.protocols['gl:'] = GL;
};

GL.prototype.getTile = function(z, x, y, callback) {

    var bbox = sm.bbox(+x,+y,+z, false, '900913');
    var center = sm.inverse([bbox[0] + ((bbox[2] - bbox[0]) * 0.5), bbox[1] + ((bbox[3] - bbox[1]) * 0.5)]);

    var options = {
        // pass center in lat, lng order
        center: center,
        width: 512,
        height: 512,
        zoom: z
    };

    this.getStatic(options, callback);
};

GL.prototype.getStatic = function(options, callback) {
    var that = this;
    this._pool.acquire(function(err, map) {

        if (err) {
          return callback(err)
        };

        map.render(options, function(err, data) {

            if (err) {
              that._pool.release(map);
              return callback(err)
            };

            var png = new Png(data, options.width * that._scale, options.height * that._scale, 'rgba');
            that._pool.release(map);

            png.encode(function(buffer){
              return callback(null, buffer, { 'Content-Type': 'image/png' });
            })
        });
    });
};

GL.prototype.getInfo = function(callback) {
  callback(null, {})
}

module.exports = GL;
