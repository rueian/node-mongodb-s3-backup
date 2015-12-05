'use strict';

var exec = require('child_process').exec
  , spawn = require('child_process').spawn
  , path = require('path')
  , domain = require('domain')
  , d = domain.create();

/**
 * log
 *
 * Logs a message to the console with a tag.
 *
 * @param message  the message to log
 * @param tag      (optional) the tag to log with.
 */
function log(message, tag) {
  var util = require('util')
    , color = require('cli-color')
    , tags, currentTag;

  tag = tag || 'info';

  tags = {
    error: color.red.bold,
    warn: color.yellow,
    info: color.cyanBright
  };

  currentTag = tags[tag] || function(str) { return str; };
  util.log((currentTag("[" + tag + "] ") + message).replace(/(\n|\r|\r\n)$/, ''));
}

/**
 * getArchiveName
 *
 * Returns the archive name in database_YYYY_MM_DD.tar.gz format.
 *
 * @param databaseName   The name of the database
 */
function getArchiveName(databaseName) {
  var date = new Date()
    , datestring;

  datestring = [
    databaseName,
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getTime()
  ];

  return datestring.join('_') + '.tar.gz';
}

/* removeRF
 *
 * Remove a file or directory. (Recursive, forced)
 *
 * @param target       path to the file or directory
 * @param callback     callback(error)
 */
function removeRF(target, callback) {
  var fs = require('fs');

  callback = callback || function() { };

  fs.exists(target, function(exists) {
    if (!exists) {
      return callback(null);
    }
    log("Removing " + target, 'info');
    exec( 'rm -rf ' + target, callback);
  });
}

/**
 * mongoDump
 *
 * Calls mongodump on a specified database.
 *
 * @param options    MongoDB connection options [host, port, username, password, db]
 * @param directory  Directory to dump the database to
 * @param callback   callback(err)
 */
function mongoDump(options, directory, callback) {
  var mongodump
    , mongoOptions;

  callback = callback || function() { };

  mongoOptions= [
    '-h', options.host + ':' + options.port,
    '-d', options.db,
    '-o', directory
  ];

  if(options.username && options.password) {
    mongoOptions.push('-u');
    mongoOptions.push(options.username);

    mongoOptions.push('-p');
    mongoOptions.push(options.password);
  }

  if(options.authenticationDatabase) {
    mongoOptions.push('--authenticationDatabase');
    mongoOptions.push(options.authenticationDatabase);
  }

  if(options.excludeCollection) {
    options.excludeCollection.forEach(function(collection) {
      mongoOptions.push('--excludeCollection');
      mongoOptions.push(collection);
    });
  }

  log('Starting mongodump of ' + options.db, 'info');
  mongodump = spawn('mongodump', mongoOptions);

  mongodump.stdout.on('data', function (data) {
    log(data);
  });

  mongodump.stderr.on('data', function (data) {
    log(data, 'error');
  });

  mongodump.on('exit', function (code) {
    if(code === 0) {
      log('mongodump executed successfully', 'info');
      callback(null);
    } else {
      callback(new Error("Mongodump exited with code " + code));
    }
  });
}

/**
 * compressDirectory
 *
 * Compressed the directory so we can upload it to S3.
 *
 * @param directory  current working directory
 * @param input     path to input file or directory
 * @param output     path to output archive
 * @param callback   callback(err)
 */
function compressDirectory(directory, input, output, callback) {
  var tar
    , tarOptions;

  callback = callback || function() { };

  tarOptions = [
    '-zcf',
    output,
    input
  ];

  log('Starting compression of ' + input + ' into ' + output, 'info');
  tar = spawn('tar', tarOptions, { cwd: directory });

  tar.stderr.on('data', function (data) {
    log(data, 'error');
  });

  tar.on('exit', function (code) {
    if(code === 0) {
      log('successfully compress directory', 'info');
      callback(null);
    } else {
      callback(new Error("Tar exited with code " + code));
    }
  });
}

/**
 * sendToS3
 *
 * Sends a file or directory to S3.
 *
 * @param options   s3 options [key, secret, bucket]
 * @param directory directory containing file or directory to upload
 * @param target    file or directory to upload
 * @param callback  callback(err)
 */
function sendToS3(options, directory, target, callback) {
  var knox = require('knox')
    , MultiPartUpload = require('knox-mpu')
    , sourceFile = path.join(directory, target)
    , s3client
    , upload
    , destination = options.destination || '/'
    , headers = {};

  callback = callback || function() { };

  // Deleting destination because it's not an explicitly named knox option
  delete options.destination;
  s3client = knox.createClient(options);

  if (options.encrypt)
    headers = {"x-amz-server-side-encryption": "AES256"}

  log('Attemping to upload ' + target + ' to the ' + options.bucket + ' s3 bucket');
  upload = new MultiPartUpload({
    client: s3client,
    objectName: path.join(destination, target),
    headers: headers,
    file: sourceFile,
    partSize: 10485760,
    maxRetries: 2
  }, function(err, body) {
    if(err) {
      return callback(err);
    }

    log('Successfully uploaded to s3');
    log(JSON.stringify(body));
    return callback();
  });
}

/**
 * sync
 *
 * Performs a mongodump on a specified database, gzips the data,
 * and uploads it to s3.
 *
 * @param mongodbConfig   mongodb config [host, port, username, password, db]
 * @param s3Config        s3 config [key, secret, bucket]
 * @param callback        callback(err)
 */
function sync(mongodbConfig, s3Config, callback) {
  var tmpDir = path.join(require('os').tmpDir(), 'mongodb_s3_backup')
    , backupDir = path.join(tmpDir, mongodbConfig.db)
    , archiveName = getArchiveName(mongodbConfig.db)
    , async = require('async')
    , tmpDirCleanupFns;

  callback = callback || function() { };

  tmpDirCleanupFns = [
    async.apply(removeRF, backupDir),
    async.apply(removeRF, path.join(tmpDir, archiveName))
  ];

  async.series(tmpDirCleanupFns.concat([
    async.apply(mongoDump, mongodbConfig, tmpDir),
    async.apply(compressDirectory, tmpDir, mongodbConfig.db, archiveName),
    d.bind(async.apply(sendToS3, s3Config, tmpDir, archiveName)) // this function sometimes throws EPIPE errors
  ]), function(err) {
    if(err) {
      log(err, 'error');
    } else {
      log('Successfully backed up ' + mongodbConfig.db);
    }
    // cleanup folders
    async.series(tmpDirCleanupFns, function() {
      return callback(err);
    });
  });

  // this cleans up folders in case of EPIPE error from AWS connection
  d.on('error', function(err) {
      d.exit()
      async.series(tmpDirCleanupFns, function() {
        throw(err);
      });
  });

}

module.exports = { sync: sync, log: log };
