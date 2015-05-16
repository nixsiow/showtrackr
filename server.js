var mongoose = require('mongoose');
var bcrypt = require('bcryptjs');

// ========= Show mongoose schema =========
// A schema is just an abstract representation of the data
// representation of data in MongoDB
var showSchema = new mongoose.Schema({
  _id: Number,
  name: String,
  airsDayOfWeek: String,
  airsTime: String,
  firstAired: Date,
  genre: [String],
  network: String,
  overview: String,
  rating: Number,
  ratingCount: Number,
  status: String,
  poster: String,
  // an array of User ObjectIDs, references to User documents.
  subscribers: [{
    type: mongoose.Schema.Types.ObjectId, ref: 'User'
  }],
  episodes: [{
    season: Number,
    episodeNumber: Number,
    episodeName: String,
    firstAired: Date,
    overview: String
  }]
});
// ========= end of Show mongoose schema =========

// ========= User mongoose schema =========
var userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String
});

// Here we are using pre-save mongoose middleware
// and comparePassword instance method for password validation
userSchema.pre('save', function(next) {
  var user = this;
  if (!user.isModified('password')) return next();
  bcrypt.genSalt(10, function(err, salt) {
    if (err) return next(err);
    bcrypt.hash(user.password, salt, function(err, hash) {
      if (err) return next(err);
      user.password = hash;
      next();
    });
  });
});

userSchema.methods.comparePassword = function(candidatePassword, cb) {
  bcrypt.compare(candidatePassword, this.password, function(err, isMatch) {
    if (err) return cb(err);
    cb(null, isMatch);
  });
};
// ========= end of User mongoose schema =========

// A model on the other hand is a concrete object
// with methods to query, remove, update and save data
// from/to MongoDB.
var User = mongoose.model('User', userSchema);
var Show = mongoose.model('Show', showSchema);
// connect to the database
mongoose.connect('mongodb://nixsiow:abcd1234@ds027479.mongolab.com:27479/nixshowtrackrapp');

// ========== End of DB Setup ==========


var express = require('express');
var path = require('path');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');

var async = require('async');
var request = require('request');
var xml2js = require('xml2js');
var _ = require('lodash');

var app = express();

app.set('port', process.env.PORT || 3000);
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ========== Query and parse the TVDB API ==========
app.post('/api/shows', function(req, res, next) {
  var apiKey = '6BD9F0C2B5363FEB';
  // xml2js parser to normalize all tags to lowercase
  // and disable conversion to arrays when there is only one child element.
  var parser = xml2js.Parser({
    explicitArray: false,
    normalizeTags: true
  });
  // exmaple: Breaking Bad it will be converted to breaking_bad
  var seriesName = req.body.showName
    .toLowerCase()
    .replace(/ /g, '_')
    .replace(/[^\w-]+/g, '');

  // async to manage multiple asynchronous operations
  async.waterfall([
    // First: Get the Show ID given the Show Name and pass it on to the next function.
    function(callback) {
      request.get('http://thetvdb.com/api/GetSeries.php?seriesname=' + seriesName, function(error, response, body) {
        if (error) return next(error);
        parser.parseString(body, function(err, result) {
          // validation check to see if the seriesid exists.
          if (!result.data.series) {
            return res.send(404, { message: req.body.showName + ' was not found.' });
          }
          var seriesId = result.data.series.seriesid || result.data.series[0].seriesid;
          callback(err, seriesId);
        });
      });
    },
    // Second: Get the show information using the Show ID from previous step and pass the new show object on to the next function.
    function(seriesId, callback) {
      request.get('http://thetvdb.com/api/' + apiKey + '/series/' + seriesId + '/all/en.xml', function(error, response, body) {
        if (error) return next(error);
        parser.parseString(body, function(err, result) {
          var series = result.data.series;
          var episodes = result.data.episode;
          var show = new Show({
            _id: series.id,
            name: series.seriesname,
            airsDayOfWeek: series.airs_dayofweek,
            airsTime: series.airs_time,
            firstAired: series.firstaired,
            genre: series.genre.split('|').filter(Boolean),
            network: series.network,
            overview: series.overview,
            rating: series.rating,
            ratingCount: series.ratingcount,
            runtime: series.runtime,
            status: series.status,
            poster: series.poster,
            episodes: []
          });
          _.each(episodes, function(episode) {
            show.episodes.push({
              season: episode.seasonnumber,
              episodeNumber: episode.episodenumber,
              episodeName: episode.episodename,
              firstAired: episode.firstaired,
              overview: episode.overview
            });
          });
          callback(err, show);
        });
      });
    },
    // Third: Convert the poster image to Base64, assign it to show.poster and pass the show object to the final callback function.
    // each image is about 30% larger in the Base64 form
    function(show, callback) {
        var url = 'http://thetvdb.com/banners/' + show.poster;
        request({ url: url, encoding: null }, function(error, response, body) {
          show.poster = 'data:' + response.headers['content-type'] + ';base64,' + body.toString('base64');
          callback(error, show);
        });
      }
    ],
    // Save the show object to database.
    function(err, show) {
      if (err) return next(err);
      show.save(function(err) {
        if (err) {
          // Error code 11000 refers to the duplicate key error.
          if (err.code == 11000) {
            // 409, HTTP status code to indicate some sort of conflict
            return res.send(409, { message: show.name + ' already exists.' });
          }
          return next(err);
        }
        res.send(200);
      });
    });
  });
  // ========== End of Query and parse the TVDB API ==========

app.get('/api/shows', function(req, res, next) {
  var query = Show.find();
  if (req.query.genre) {
    query.where({ genre: req.query.genre });
  } else if (req.query.alphabet) {
    query.where({ name: new RegExp('^' + '[' + req.query.alphabet + ']', 'i') });
  } else {
    query.limit(12);
  }
  query.exec(function(err, shows) {
    if (err) return next(err);a
    res.send(shows);
  });
});

app.get('/api/shows/:id', function(req, res, next) {
  Show.findById(req.params.id, function(err, show) {
    // If there an error it will be passed on to the error middleware and handled there as well.
    if (err) return next(err);
    res.send(show);
  });
});

// Common problem when you use HTML5 pushState on the client-side
// Create a redirect route.
// Add this route before the error handler
// * wild card that will match any route that you type.
app.get('*', function(req, res) {
  res.redirect('/#' + req.originalUrl);
});

app.use(function(err, req, res, next) {
  console.error(err.stack);
  res.send(500, { message: err.message });
});

app.listen(app.get('port'), function() {
  console.log('Express server listening on port ' + app.get('port'));
});
