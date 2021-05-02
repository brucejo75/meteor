import {_} from 'meteor/underscore';
// Publish the current client versions for each client architecture
// (web.browser, web.browser.legacy, web.cordova). When a client observes
// a change in the versions associated with its client architecture,
// it will refresh itself, either by swapping out CSS assets or by
// reloading the page. Changes to the replaceable version are ignored
// and handled by the hot-module-replacement package.
//
// There are four versions for any given client architecture: `version`,
// `versionRefreshable`, `versionNonRefreshable`, and
// `versionReplaceable`. The refreshable version is a hash of just the
// client resources that are refreshable, such as CSS. The replaceable
// version is a hash of files that can be updated with HMR. The
// non-refreshable version is a hash of the rest of the client assets,
// excluding the refreshable ones: HTML, JS that is not replaceable, and
// static files in the `public` directory. The `version` version is a
// combined hash of everything.
//
// If the environment variable `AUTOUPDATE_VERSION` is set, it will be
// used in place of all client versions. You can use this variable to
// control when the client reloads. For example, if you want to force a
// reload only after major changes, use a custom AUTOUPDATE_VERSION and
// change it only when something worth pushing to clients happens.
//
// The server publishes a `meteor_autoupdate_clientVersions` collection.
// The ID of each document is the client architecture, and the fields of
// the document are the versions described above.

import { ClientVersions } from "./client_versions.js";
var Future = Npm.require("fibers/future");

const Autoupdate = __meteor_runtime_config__.autoupdate = {
  // Map from client architectures (web.browser, web.browser.legacy,
  // web.cordova) to version fields { version, versionRefreshable,
  // versionNonRefreshable, refreshable } that will be stored in
  // ClientVersions documents (whose IDs are client architectures). This
  // data gets serialized into the boilerplate because it's stored in
  // __meteor_runtime_config__.autoupdate.versions.
  versions: {}
};

// Stores acceptable client versions.
const clientVersions = new ClientVersions();

// The client hash includes __meteor_runtime_config__, so wait until
// all packages have loaded and have had a chance to populate the
// runtime config before using the client hash as our default auto
// update version id.

// Note: Tests allow people to override Autoupdate.autoupdateVersion before
// startup.
Autoupdate.autoupdateVersion = null;
Autoupdate.autoupdateVersionRefreshable = null;
Autoupdate.autoupdateVersionCordova = null;
Autoupdate.appId = __meteor_runtime_config__.appId = process.env.APP_ID;

var syncQueue = new Meteor._SynchronousQueue();

function updateVersions(shouldReloadClientProgram) {
  // Step 1: load the current client program on the server
  if (shouldReloadClientProgram) {
    WebAppInternals.reloadClientPrograms();
  }

  const {
    // If the AUTOUPDATE_VERSION environment variable is defined, it takes
    // precedence, but Autoupdate.autoupdateVersion is still supported as
    // a fallback. In most cases neither of these values will be defined.
    AUTOUPDATE_VERSION = Autoupdate.autoupdateVersion
  } = process.env;

  // Step 2: update __meteor_runtime_config__.autoupdate.versions.
  const clientArchs = Object.keys(WebApp.clientPrograms);
  clientArchs.forEach(arch => {
    Autoupdate.versions[arch] = {
      version: AUTOUPDATE_VERSION ||
        WebApp.calculateClientHash(arch),
      versionRefreshable: AUTOUPDATE_VERSION ||
        WebApp.calculateClientHashRefreshable(arch),
      versionNonRefreshable: AUTOUPDATE_VERSION ||
        WebApp.calculateClientHashNonRefreshable(arch),
      versionReplaceable: AUTOUPDATE_VERSION ||
        WebApp.calculateClientHashReplaceable(arch)
    };
  });

  // Step 3: form the new client boilerplate which contains the updated
  // assets and __meteor_runtime_config__.
  if (shouldReloadClientProgram) {
    WebAppInternals.generateBoilerplate();
  }

  // Step 4: update the ClientVersions collection.
  // We use `onListening` here because we need to use
  // `WebApp.getRefreshableAssets`, which is only set after
  // `WebApp.generateBoilerplate` is called by `main` in webapp.
  WebApp.onListening(() => {
    clientArchs.forEach(arch => {
      const payload = {
        ...Autoupdate.versions[arch],
        assets: WebApp.getRefreshableAssets(arch),
      };

      clientVersions.set(arch, payload);
    });
  });
}

Meteor.publish(
  "meteor_autoupdate_clientVersions",
  function (appId) {
    // `null` happens when a client doesn't have an appId and passes
    // `undefined` to `Meteor.subscribe`. `undefined` is translated to
    // `null` as JSON doesn't have `undefined.
    check(appId, Match.OneOf(String, undefined, null));


    let toWatch = clientVersions;
    if (Autoupdate.appId && appId && Autoupdate.appId !== appId) {
      // This is a different app than this app
      // If there is an AutoupdateHookOtherClient for this appId
      // then use it's watcher
      toWatch = otherClientVersion.watcher(appId);
      if(!toWatch) return []; // bail
    }

    // Set up the watcher for this version or hooked other versions
    const stop = toWatch.watch((version, isNew) => {
      (isNew ? this.added : this.changed)
        .call(this, "meteor_autoupdate_clientVersions", version._id, version);
    });

    this.onStop(() => stop());
    this.ready();
  },
  {is_auto: true}
);

Meteor.startup(function () {
  updateVersions(false);

  // Force any connected clients that are still looking for these older
  // document IDs to reload.
  ["version",
   "version-refreshable",
   "version-cordova",
  ].forEach(_id => {
    clientVersions.set(_id, {
      version: "outdated"
    });
  });
});

var fut = new Future();

// We only want 'refresh' to trigger 'updateVersions' AFTER onListen,
// so we add a queued task that waits for onListen before 'refresh' can queue
// tasks. Note that the `onListening` callbacks do not fire until after
// Meteor.startup, so there is no concern that the 'updateVersions' calls from
// 'refresh' will overlap with the `updateVersions` call from Meteor.startup.

syncQueue.queueTask(function () {
  fut.wait();
});

WebApp.onListening(function () {
  fut.return();
});

function enqueueVersionsRefresh() {
  syncQueue.queueTask(function () {
    updateVersions(true);
  });
}

// Listen for messages pertaining to the client-refresh topic.
import { onMessage } from "meteor/inter-process-messaging";
onMessage("client-refresh", enqueueVersionsRefresh);

// Another way to tell the process to refresh: send SIGHUP signal
process.on('SIGHUP', Meteor.bindEnvironment(function () {
  enqueueVersionsRefresh();
}, "handling SIGHUP signal for refresh"));

// OtherClientVersion
// This class handles hooking autoupdate for versions other than
// the version of this server
// This is useful if you want to create multiple client applications that use
// a DDP connection to a "main server.  Then AutoupdateHookOtherClient can
// be used to set the autoupdate parameters for different appIds
export class OtherClientVersion {
  constructor() {
    this.versions = new Map();
    this.watchCallbacks = new Map();
    this.watchers = new Map();
    this.outdateds = [
      {'_id': 'version', 'version': 'outdated'},
      {'_id': 'version-refreshable', 'version': 'outdated'},
      {'_id': 'version-cordova', 'version': 'outdated'},
    ];
  }

  // Used by the publish function
  // returns the watch function for this appId
  watcher(appId) {
    const self = this;
    const versions = self.versions.get(appId);

    // No versions for this appID? bail
    if(!versions) return undefined;

    return {
      // essentially this registers the callback
      watch(fn) {
        const resolved = Promise.resolve();
        // Initial call to watch will fire the
        // outdateds followed by callback for each version
        // it is the only time outdates are sent
        self.outdateds.forEach((version) => {
          // initial callback always isNew
          resolved.then(() => fn(version, true));
        });
        versions.forEach((version) => {
          // initial callback always isNew
          resolved.then(() => fn(version, true));
        });

        // add this callback to the list for this appId
        let fns = self.watchCallbacks.get(appId) || [];
        fns.push(fn);
        self.watchCallbacks.set(appId, fns);
    
        // this will be used as the stop function for the subscription
        return () => {
          // remove this callback from the list of callbacks
          let fns = self.watchCallbacks.get(appId);
          let idx = fns.indexOf(fn);
          if(idx > -1) fns.splice(idx, 1);
          self.watchCallbacks.set(appId, fns);
        }
      }
    };
  }

  // This method is called if an appId has updated version information
  // for the appId
  update(appId, autoUpdate) {
    // create versions update array for this appId
    const versions = [
      _.extend({'_id': 'web.browser'}, autoUpdate.versions['web.browser']),
      _.extend({'_id': 'web.browser.legacy'}, autoUpdate.versions['web.browser.legacy']),
      _.extend({'_id': 'web.cordova'}, autoUpdate.versions['web.cordova']),
    ];

    // All callbacks here are not new
    // The initial callbacks are called when the watcher is
    // requested for this appId
    this.versions.set(appId, versions);
    let callbacks = this.watchCallbacks.get(appId);
    // for every callback on this appId
    if(callbacks) {
      const resolved = Promise.resolve();
      callbacks.forEach((cb) => {
        // send down updates (isNew === false)
        versions.forEach((ver) => {
          resolved.then(() => cb(ver, false));
        });
      });
    }
  }
}

const otherClientVersion = new OtherClientVersion();
module.exports.AutoupdateHookOtherClient = otherClientVersion.update.bind(otherClientVersion);
module.exports.Autoupdate = Autoupdate;