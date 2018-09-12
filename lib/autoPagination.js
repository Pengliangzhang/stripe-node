'use strict';

var makeRequest = require('./makeRequest');
var utils = require('./utils');

function getItemCallback(args) {
  if (args.length === 0) {
    return undefined;
  }
  var onItem = args[0];
  if (typeof onItem !== 'function') {
    throw Error('The first argument to autoPagingEach, if present, must be a callback function; receieved ' + typeof onItem);
  }

  // `.autoPagingEach((item, next) => { doSomething(item); next(); });`
  if (onItem.length === 2) {
    return onItem;
  }

  if (onItem.length > 2) {
    throw Error('The `onItem` callback function passed to autoPagingEach must accept at most two arguments; got ' + onItem);
  }

  // API compat; turn this:
  //    .autoPagingEach((item) => { doSomething(item); return false; });
  // into this:
  //    .autoPagingEach((item, next) => { doSomething(item); next(false); });
  return function(item, next) {
    var shouldContinue = onItem(item);
    next(shouldContinue);
  };
}

function getDoneCallback(args) {
  if (args.length < 2) {
    return undefined;
  }
  var onDone = args[1];
  if (typeof onDone !== 'function') {
    throw Error('The second argument to autoPagingEach, if present, must be a callback function; receieved ' + typeof onDone);
  }
  return onDone;
}

function wrapAsyncIteratorWithCallback(asyncIteratorNext, onItem) {
  return new Promise(function(resolve, reject) {
    function handleIteration(iterResult) {
      if (iterResult.done) {
        resolve();
        return;
      }

      var item = iterResult.value;
      return new Promise(function(next) {
        // Bit confusing, perhaps; we pass a `resolve` fn
        // to the user, so they can decide when and if to continue.
        onItem(item, next);
      }).then(function(shouldContinue) {
        if (shouldContinue === false) {
          return handleIteration({done: true});
        } else {
          return asyncIteratorNext().then(handleIteration);
        }
      });
    }

    asyncIteratorNext().then(handleIteration).catch(reject);
  });
}

function autoPagingEach(self, requestArgs, spec, firstPagePromise) {
  return function autoPagingEach(/* onItem?, onDone? */) {
    var args = [].slice.call(arguments);
    var onItem = getItemCallback(args);
    var onDone = getDoneCallback(args);
    if (args.length > 2) {
      throw Error('autoPagingEach takes up to two arguments; received:', args);
    }

    function requestNextPage(listResult) {
      var lastIdx = listResult.data.length - 1;
      var lastItem = listResult.data[lastIdx];
      var lastId = lastItem && lastItem.id;
      if (!lastId) {
        throw Error('Unexpected: No `id` found on the last item while auto-paging a list.');
      }
      return makeRequest(self, requestArgs, spec, {starting_after: lastId});
    }

    // If a user calls `.next()` multiple times in parallel,
    // return the same result until something has resolved
    // to prevent page-turning race conditions.
    var currentPromise;
    function memoizedPromise(cb) {
      if (currentPromise) {
        return currentPromise;
      }
      currentPromise = new Promise(cb).then(function(ret) {
        currentPromise = undefined;
        return ret;
      });
      return currentPromise;
    }

    // Iterator state.
    var listPromise = firstPagePromise;
    var i = 0;

    function iterate(listResult) {
      if (i < listResult.data.length) {
        var value = listResult.data[i];
        i += 1;
        return {value: value, done: false};
      } else if (listResult.has_more) {
        // Reset counter, request next page, and recurse.
        i = 0;
        listPromise = requestNextPage(listResult);
        return listPromise.then(iterate);
      }
      return {value: undefined, done: true};
    }

    function asyncIteratorNext() {
      return memoizedPromise(function(resolve, reject) {
        return listPromise
          .then(iterate)
          .then(resolve)
          .catch(reject);
      });
    }

    // Bifurcate API for those using callbacks vs. those using async iterators.
    if (onItem) {
      var autoPagePromise = wrapAsyncIteratorWithCallback(asyncIteratorNext, onItem);
      return utils.callbackifyPromise(autoPagePromise, onDone);
    } else {
      var iterator = {
        next: asyncIteratorNext,
        return: function() {
          // This is required for `break`.
          return {};
        },
      }
      if (typeof Symbol !== 'undefined' && Symbol.asyncIterator) {
        iterator[Symbol.asyncIterator] = function() {
          return iterator;
        }
      }
      return iterator;
    }
  };
}

function autoPagingToArray(asyncIterator) {
  return function autoPagingToArray(opts, onDone) {
    var max = opts && opts.max;
    if (!max) {
      throw Error('You must pass a `max` option to autoPagingToArray, eg; `autoPagingToArray({max: 1000});`.');
    }
    if (max > 10000) {
      throw Error('You cannot specify a max of more than 10,000 items to fetch in `autoPagingToArray`; use `autoPagingEach` to iterate through longer lists.');
    }
    var promise = new Promise(function(resolve, reject) {
      var items = [];
      asyncIterator(function(item) {
        items.push(item);
        if (items.length >= max) {
          return false;
        }
      }).then(function() {
        resolve(items);
      }).catch(reject);
    });
    return utils.callbackifyPromise(promise, onDone);
  }
}

module.exports.autoPagingEach = autoPagingEach;
module.exports.autoPagingToArray = autoPagingToArray;