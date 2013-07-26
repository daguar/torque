(function(exports) {

  exports.torque = exports.torque || {};
  var providers = exports.torque.providers = exports.torque.providers || {};

  // format('hello, {0}', 'rambo') -> "hello, rambo"
  function format(str) {
    for(var i = 1; i < arguments.length; ++i) {
      var attrs = arguments[i];
      for(var attr in attrs) {
        str = str.replace(RegExp('\\{' + attr + '\\}', 'g'), attrs[attr]);
      }
    }
    return str;

  }

  var json = function (options) {
    this._ready = false;
    this.options = options;
    this._tileQueue = [];

    // check options
    if (options.resolution === undefined ) throw new Error("resolution should be provided");
    if(options.start === undefined) {
      this.getKeySpan();
    } else {
      this._ready = true;
    }
  };

  json.prototype = {

    /**
     * return the torque tile encoded in an efficient javascript
     * structure:
     * {
     *   x:Uint8Array x coordinates in tile reference system, normally from 0-255
     *   y:Uint8Array y coordinates in tile reference system
     *   Index: Array index to the properties
     * }
     */
    proccessTile: function(rows, coord, zoom) {
      var x = new Uint8Array(rows.length);
      var y = new Uint8Array(rows.length);

      // count number of dates
      var dates = 0;
      var maxDateSlots = 0;
      for (var r = 0; r < rows.length; ++r) {
        var row = rows[r];
        dates += row['dates__uint16'].length;
        maxDateSlots = Math.max(maxDateSlots, row.dates__uint16.length);
      }

      // reserve memory for all the dates
      var timeIndex = new Int32Array(maxDateSlots); //index-size
      var timeCount = new Int32Array(maxDateSlots);
      var renderData = new Uint8Array(dates);
      var renderDataPos = new Uint32Array(dates);

      var rowsPerSlot = [];

      // precache pixel positions
      for (var r = 0; r < rows.length; ++r) {
        var row = rows[r];
        x[r] = row.x__uint8;
        y[r] = row.y__uint8;

        var dates = rows[r]['dates__uint16'];
        var vals = rows[r]['vals__uint8'];
        for (var j = 0, len = dates.length; j < len; ++j) {
            var rr = rowsPerSlot[dates[j]] || (rowsPerSlot[dates[j]] = []);
            rr.push([r, vals[j]]);
        }
      }

      // for each timeslot search active buckets
      var renderDataIndex = 0;
      var timeSlotIndex = 0;
      for(var i = 0; i < maxDateSlots; ++i) {
        var c = 0;
        var slotRows = rowsPerSlot[i]
        if(slotRows) {
          for (var r = 0; r < slotRows.length; ++r) {
            var rr = slotRows[r];
            ++c;
            renderDataPos[renderDataIndex] = rr[0]
            renderData[renderDataIndex] = rr[1];
            ++renderDataIndex;
          }
        }
        /*
        for (var r = 0; r < rows.length; ++r) {
          var dates = rows.get('dates__uint16')[r];
          var vals = rows.get('vals__uint8')[r];
          for (var j = 0, len = dates.length; j < len; ++j) {
            if(dates[j] == i) {
              ++c;
              renderData[renderDataIndex] = vals[j];
              renderDataPos[renderDataIndex] = r;
              ++renderDataIndex;
            }
          }
        }
        */
        timeIndex[i] = timeSlotIndex;
        timeCount[i] = c;
        timeSlotIndex += c;
      }

      return {
        x: x,
        y: y,
        coord: {
          x: coord.x,
          y: coord.y,
          z: zoom,
        },
        timeCount: timeCount,
        timeIndex: timeIndex,
        renderDataPos: renderDataPos,
        renderData: renderData
      };
    },

    url: function() {
      return this.options.url || 'http://' + this.options.user + '.cartodb.com/api/v2/sql';
    },

    // execute actual query
    sql: function(sql, callback, options) {
      options = options || {};
      torque.net.get(this.url() + "?q=" + encodeURIComponent(sql), function (data) {
          if(options.parseJSON) {
            data = JSON.parse(data.responseText);
          }
          callback(data);
      });
    },

    getTileData: function(coord, zoom, callback) {
      if(!this._ready) {
        this._tileQueue.push([coord, zoom, callback]);
      } else {
        this._getTileData(coord, zoom, callback);
      }
    },

    _setReady: function(ready) {
      this._ready = true;
      this._processQueue();
    },

    _processQueue: function() {
      var item;
      while (item = this._tileQueue.pop()) {
        this._getTileData.apply(this, item);
      }
    },

    /**
     * `coord` object like {x : tilex, y: tiley }
     * `zoom` quadtree zoom level
     */
    _getTileData: function(coord, zoom, callback) {
      this.table = this.options.table;
      var numTiles = 1 << zoom;

      var column_conv = this.options.column;

      if(this.options.is_time) {
        column_conv = format("date_part('epoch', {column})", this.options);
      }

      var sql = "" +
        "WITH " +
        "par AS (" +
        "  SELECT CDB_XYZ_Resolution({zoom})*{resolution} as res" +
        ", CDB_XYZ_Extent({x}, {y}, {zoom}) as ext "  +
        ")," +
        "cte AS ( "+
        "  SELECT ST_SnapToGrid(i.the_geom_webmercator, p.res) g" +
        ", {countby} c" +
        ", floor(({column_conv} - {start})/{step}) d" +
        "  FROM {table} i, par p " +
        "  WHERE i.the_geom_webmercator && p.ext " +
        "  GROUP BY g, d" +
        ") " +
        "" +
        "SELECT least((st_x(g)-st_xmin(p.ext))/p.res, 255) x__uint8, " +
        "       least((st_y(g)-st_ymin(p.ext))/p.res, 255) y__uint8," +
        " array_agg(c) vals__uint8," +
        " array_agg(d) dates__uint16" +
        " FROM cte, par p GROUP BY x__uint8, y__uint8";

      var query = format(sql, this.options, {
        zoom: zoom,
        x: coord.x,
        y: coord.y,
        column_conv: column_conv
      });

      var self = this;
      this.sql(query, function (data) {
        var rows = JSON.parse(data.responseText).rows;
        callback(self.proccessTile(rows, coord, zoom));
      });
    },



    //
    // the data range could be set by the user though ``start``
    // option. It can be fecthed from the table when the start
    // is not spcified
    //
    getKeySpan: function() {
      var max_col, min_col;

      if (this.options.is_time){
        max_col = format("date_part('epoch', max({column}))", {
          column: this.options.column
        });
        min_col = format("date_part('epoch', min({column}))", {
          column: this.options.column
        });
      } else {
        max_col = format("max({0})", {
          column: this.options.column
        });
        min_col = format("min({0})", {
          column: this.options.column
        });
      }

      var sql = format("SELECT st_xmax(st_envelope(st_collect(the_geom))) xmax,st_ymax(st_envelope(st_collect(the_geom))) ymax, st_xmin(st_envelope(st_collect(the_geom))) xmin, st_ymin(st_envelope(st_collect(the_geom))) ymin, {max_col} max, {min_col} min FROM {table}", {
        max_col: max_col,
        min_col: min_col,
        table: this.options.table
      })

      var self = this;
      this.sql(sql, function(data) {
        //TODO: manage bounds
        data = data.rows[0];
        self.options.start = data.min;
        self.options.step = (data.max - data.min)/self.options.steps;
        self._setReady(true);
      }, { parseJSON: true });
    }

  };

  torque.providers.json = json


})(typeof exports === "undefined" ? this : exports);