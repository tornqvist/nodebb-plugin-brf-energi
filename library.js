"use strict";

var User = require.main.require('./src/user');
var Groups = require.main.require('./src/groups');
var Configs = require.main.require('./src/meta/configs');
var Meta = require.main.require('./src/meta');
var passport = module.parent.require('passport');
var PasswordStrategy = module.parent.require('passport-local').Strategy;
var winston = module.parent.require('winston');
var async = module.parent.require('async');
var nconf = module.parent.require('nconf');
var metry = module.parent.require('nodebb-plugin-sso-metry');
var CustomStrategy = require('passport-custom').Strategy;
var encryptor = require('simple-encryptor')(nconf.get('URL_ENCRYPTION_KEY'));
var authenticationController = require.main.require('./src/controllers/authentication');
var jwt = require("jsonwebtoken");

var controllers = require('./lib/controllers');

var plugin = {};

plugin.preinit = function(params, callback) {
  winston.info("Plugin happens");
  var app = params.app;
  app.get('/test', function(req, res, next) {
    winston.info("Request happens");
    res.send(505);
  });

  callback();
};

// This plugin defines a login strategy, but it's a background thing, we don't want users to actually see it.
function overrideAuthStrategyGetter() {
	var authLib = require.main.require('./src/routes/authentication');
	var origFunction = authLib.getLoginStrategies;
	authLib.getLoginStrategies = function() {
		return origFunction().filter(strategy => strategy.name != constants.name);
	}
}

plugin.init = function(params, callback) {
  var app = params.app;
  var router = params.router;
  var hostMiddleware = params.middleware;
  var hostControllers = params.controllers;

  overrideAuthStrategyGetter();
  // We create two routes for every view. One API call, and the actual route itself.
  // Just add the buildHeader middleware to your route and NodeBB will take care of everything for you.

  router.get('/admin/plugins/brf-energi', hostMiddleware.admin.buildHeader, controllers.renderAdminPage);
  router.get('/api/admin/plugins/brf-energi', controllers.renderAdminPage);
  router.get('/api/whoami', passport.authenticate("brf"), function(req, res, next) {
  	if(req.user) {
  		console.log(req.user)
  		res.send({username: req.user.username, uid: req.user.uid});
		} else {
  		res.sendStatus(403);
		}
	})
  router.get('/authmetryifneeded', function(req, res, next) {
    var tok = req.query.brfauth;
    console.log(tok)
    var secret = nconf.get('BRFENERGI_SESSION_SECRET')
    try{
      var obj = jwt.verify(tok, secret);
      console.log(obj);
    } catch(e) {
      console.log("No valid jwt");
    }

    if(req.loggedIn){
      res.redirect("/");
    } else {
      res.redirect("/auth/metry");
    }
  });

  router.get('/brftouch', function(req, res, next) {
    //Basically must use the same strategy as the metry code, just different end action
    //should return an userId

    //This could basically be a wrapper around metrysso login


    // SO: email, username, metryid
    // If metry present:
    //   use oauth login first. If that gives a uid:
    //   do we check the email? no... I suppose we just return it then.
    //   And so it will be made that an accound with that metry surely exists.
    //
    // If not present:
    // Either find the user or create them.

    touchAuthenticatedUser(req.body.token, function(err, uidObject){
      if(err || !uidObject) return res.send(400);
      res.send({uid: uidObject.uid});
    });


/*
    var token = req.body.token;
    if(!!token) {
      res.status(400);
      return;
    }

    var secret = nconf.get('BRFENERGI_SESSION_SECRET');
    var decoded;
    try{
      var decoded = jwt.verify(tok, secret);
    } catch(e) {
      res.status(500);
      return;
    }

    if(!!decoded.metryId) {

      return;
    }
    res.status(402);
    return;

    // TOO get user by email and then either login or create
    */
  });

  router.get('/brfauth/uid',
    // just normal authentication. But or is this a new strategy? 
    //should return an userId
    passport.authenticate('local', {}),
    function (req, res) {
      res.send({uid: req.uid});
    }
  );


  // Automatically setting right config options so forum works well basically
  Configs.set("powered-by", "ballmer-peak", (err) => {
    if(err) winston.error(err);
    else winston.info("set powered-by");
  });

  Configs.set("access-control-allow-origin-regex", ".*", (err) => {
    if(err) winston.error(err);
    else winston.info("set origin regex");
  });

  Configs.set("access-control-allow-headers", "Content-Type,User-Agent,brfauth,Cache-Control", (err) => {
    if(err) winston.error(err);
    else winston.info("set allowheaders");
  });

  Groups.join('cid:' + 0 + ':privileges:' + 'groups:local:login', 'registered-users', (err) => {
    if(err) winston.error(err);
    else winston.info("Successfully joined group for privileges");
  });

  Meta.settings.setOne('writeapi', 'jwt:secret', 'testturu', function(err) {
    if(err) {console.log(err);}
    console.log("Seems we have set the setting");
  })

  winston.info("Set up plugin BRF!");

  callback();
};

plugin.authByBrf = function({req, res, next}) {
  console.log("Auht by brf!")
  passport.authenticate("brf", {failureRedirect: nconf.get('url') + '/login'})(req, res, next)
}

plugin.auth = function({req, res, next}) {
  console.log("WHAT")
  winston.info("User is not authed!");
  next();
}

plugin.addAdminNavigation = function(header, callback) {
  header.plugins.push({
    route: '/plugins/brf-energi',
    icon: 'fa-tint',
    name: 'brf-energi'
  });

  callback(null, header);
};


function touchAuthenticatedUser(profileToken, callback) {
  var fail = (msg) => {winston.error(msg); return callback(null, null);};
  if(!profileToken) return fail('No JWT provided for brf authentication');

  async.waterfall([
    function (next) {
      var secret = nconf.get('BRFENERGI_SESSION_SECRET');
      console.log("Tryna decoe")
      console.log(profileToken)
      console.log(secret)
      jwt.verify(profileToken, secret, next);
    },
    function(profile, next) {
      if(!profile) return fail("Profile could not be extracted from message.");
      if(!profile.name) return fail("No name provided in JWT from BRF.");
      if(!profile.email) return fail("No email provided in JWT from BRF.");

      if(!!profile.metryID) {
        var metryLoginPayload = { // intentionally skipping isAdmin - admin on BRF does not mean admin on forum.
          oAuthid: profile.metryID,
          handle: profile.name,
          email: profile.email,
        };
        metry.login(metryLoginPayload, next)
      } else {
        User.getUidByEmail(profile.email, function(err, uid) {
          if(err) {
            res.status(500);
            console.log(err);
            return;
          }

          if(uid) {
            next(null, {uid: uid});
          } else {
            User.create({username: profile.name, email: profile.email}, function(err, uid) {
              next(err, {uid: uid});
            });
          }
        })
      }
    },
  ], function(err, user) {
    if(err) {
      winston.error(err);
    }

    callback(err, user)
  })
}


function loginUserByBrf(req, callback) {
  var fail = (msg) => {winston.error(msg); return callback(null, null);};
  var profileToken = req.query.brfauth || req.body.brfauth || req.headers.brfauth;
  if(!profileToken) return fail('No JWT provided for brf authentication');

  async.waterfall([
    function (next) {
      var secret = nconf.get('BRFENERGI_SESSION_SECRET');
      jwt.verify(profileToken, secret, next);
    },
    function(profileContainer, next) {
      if(!profileContainer.msg) return fail("No encrypted message in JWT");

      var profile = encryptor.decrypt(profileContainer.msg);

      if(!profile) return fail("Profile could not be decrypted from message.");
      if(!profile.metryID) return fail("No metryID provided in JWT from BRF.");
      if(!profile.name) return fail("No name provided in JWT from BRF.");
      if(!profile.email) return fail("No email provided in JWT from BRF.");

      var metryLoginPayload = { // intentionally skipping isAdmin - admin on BRF does not mean admin on forum.
        oAuthid: profile.metryID,
        handle: profile.name,
        email: profile.email,
      };
      metry.login(metryLoginPayload, next)
    },
    function(uidObj, next) {
      var uid = uidObj.uid;
      User.getUsers([uid], null, next);
    },
    function(users, next) {
      if(users.length !== 1) {
        return next("Wrong users length!");
      }

      next(null, users[0]);
    }
  ], function(err, user) {
    if(err) {
      winston.error(err);
      callback(err, user);
      return
    }

		// Need to do this manually because nodebb is stupid. Replicating /src/routes/authentication line 28
		req.uid = user.uid
		req.loggedIn = true
    authenticationController.onSuccessfulLogin(req, user.uid);
    callback(err, user)
  })
}

/**
 * We add a strategy that exists on the callback endpoint visible later
 * Makes it possible to authorize with one URL, no redirects/interstitals/callbacks.
 * @param brfauth (URL parameter) makes a claim that a certain user is logged in at BRF, and should
 * therefore be granted access to nodebb. If the claim is valid, we auth the user (if already has account,
 * log in, otherwise create profile from information in the param.
 * Structure:
 * brfauth is a JWT signed with BRFENERGI_SESSION_SECRET on form:
 * {
 *   msg: PROFILE,
 *   [iat,]
 *   [exp,]
 *   [...]
 * }
 * The signing makes sure only BRFEenergi could have made the claim, since only it has access to the shared secret.
 * PROFILE must be an encrypted string.
 * PROFILE must be decryptable by simple-encryptor with the key URL_ENCRYPTION_KEY. It should decrypt to a JSON object
 * of structure:
 * {
 *   metryID,
 *   name,
 *   email
 * }
 * These things are necessary for creating a new profile if needed. Encryption is done because all this data lies in
 * the URL which might be logged basically anywhere, and email is sensitive data.
 */
var constants = Object.freeze({
  name: 'brf',
});
plugin.addStrategy = function(strategies, callback) {
  passport.use(constants.name, new CustomStrategy(loginUserByBrf));

  strategies.push({
    name: constants.name,
    // url: '',
    callbackURL: '/auth/' + constants.name ,
    icon: 'fa-check-square',
    scope: 'basic'
  });

  return callback(null, strategies);
};

module.exports = plugin;

//	{ "hook": "static:app.preload", "method": "preinit" },
//	{ "hook": "filter:admin.header.build", "method": "addAdminNavigation" },
// 	{ "hook": "action:middleware.authenticate", "method": "auth" },

