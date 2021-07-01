/*
 * The actual work happens here.
 */

'use strict';

const crypto = require('crypto');

const redis = require('redis');
const RedisError = redis.RedisError;

const tools = require("./toolbox");
const timer = new (require("./Timer"))(inspectQueue);
const config = require("./config.json");

module.exports = {
	setUp,
	shutDown,
	enqueue
};

let db, sub; // the database connections, one of which is dedicated to subscribing
let latency = 0; // how much time may a database request cost (probed) 
let nextDueTime; // the time at which the next message must be printed
let upToDate; // flag indicating whether the value of 'nextDueTime' is reliable
let inspectingQueue, resumeInspection; // flags used during message processing

const PROCESSING_WINDOW = 1000; // duration of reservation for a message processing
const PROCESSING_RETRY_DELAY = Math.ceil(1.1 * PROCESSING_WINDOW); // dequeuing retry delay
const PROCESSING_BATCH_SIZE = 30; // batch size for dequeuing

// Redis key names
const QUEUE = "msgq";
const CONTENT_PREFIX = "msg:";
const LOCK_PREFIX = "lk:";
const NEXT_DUE_TIME_CHANNEL = Buffer.from("ndt");

const FORMATTER = new Intl.NumberFormat(tools.getDefaultLocale(), {
	style: "unit",
	unitDisplay: "short",
	unit: "millisecond",
	signDisplay: "exceptZero"
});

function connectionRetryDelay({ attempt, timesConnected, totalRetryTime }) {
	// limit the number of attempts, based on how good is the link
	if (attempt > 3 + Math.max(timesConnected, 5))
		return;

	return attempt === 1 ? 100 : totalRetryTime / (attempt - 1) * 2;
}

// sets up the database connections and more
function setUp(callback) {
	let dbReady, subReady;

	// establish the regular connection
	config.redis.retry_strategy = connectionRetryDelay;
	db = redis.createClient(config.redis);
	db.on('error', (error) => {
		if (callback)
			callback(error);
		else {
			console.error("Unable to reconnect to the indicated Redis database.");
			tools.exit(error);
		}
	});
	db.on('warning', (message) => {
		console.error("Warning about the Redis database:\n\t" + message);
	});
	db.on('end', () => {
		dbReady = false;
	});
	db.on('ready', () => {
		dbReady = true;
		if (subReady)
			obtainNextDueTime();
	});

	// establish the subscribing connection
	sub = db.duplicate();
	sub.on('error', (error) => {
		if (callback)
			callback(error);
		else {
			console.error("Unable to resubscribe to the indicated Redis database.");
			tools.exit(error);
		}
	});
	sub.on('warning', (message) => {
		console.error("Warning about the Redis database:\n\t" + message);
	});
	sub.on('end', () => {
		upToDate = false;
		subReady = false;
	});
	sub.on('ready', () => {
		// subscribe to the time publishing channel
		sub.subscribe(NEXT_DUE_TIME_CHANNEL);
	});
	sub.on('subscribe', () => {
		subReady = true;
		if (dbReady)
			obtainNextDueTime();
	});
	sub.on('message_buffer', (_, time) => {
		setNextDueTime(tools.bufferToNumber(time));
	});

	function obtainNextDueTime() {
		// read the next message's due time, obtaining the latency in the process
		let now = Date.now();
		db.zrange(QUEUE, 0, 0, 'WITHSCORES', (error, response) => {
			if (error) {
				if (callback)
					callback(error);
				else console.error(error, "\n>>> Could not read the next message's due time.");
				return;
			}

			// the latency is always updated, while the next message's due time only if needed
			latency = Date.now() - now;
			if (!upToDate)
				setNextDueTime(response.length ? Number.parseInt(response[1], 10) : null);

			if (callback) {
				// the setup was successful
				callback();
				callback = null;
			}
		});
	}

	function setNextDueTime(time) {
		upToDate = true;
		nextDueTime = time;

		if (time == null)
			timer.cancel();
		else timer.trigger(time - 3 * latency); // at least three database queries are carried out before actually displaying a message
	}
}

// cleans up everything
function shutDown(callback) {
	timer.cancel();

	let conn = 0;
	let done = () => {
		conn--;
		if (!conn)
			callback();
	};

	if (db) {
		conn++;
		db.end(true);
		if (callback)
			db.stream.on('close', done);
	}
	if (sub) {
		conn++;
		sub.end(true);
		if (callback)
			sub.stream.on('close', done);
	}
}

// enqueues one message
function enqueue(time, text, callback) {
	let id = getMessageId(time, text);
	let multi = db.multi()
		.set(CONTENT_PREFIX + id, text)
		.zadd(QUEUE, time, id);

	if (!upToDate || nextDueTime == null || time < nextDueTime) {
		// keep everybody up to date
		multi.publish(NEXT_DUE_TIME_CHANNEL, tools.numberToBuffer(time));
	}
	multi.exec((error, responses) => {
		if (error)
			return callback(error); // no operation was attempted

		// check for individual errors
		if ((error = firstRedisError(responses))) {
			// rollback the database writes
			return db.batch()
				.zrem(QUEUE, id)
				.del(CONTENT_PREFIX + id)
				.exec((err) => {
					if (err)
						console.error(err, "\n>>> Could not rollback the write operations.");

					callback(error);
				});
		}

		if (responses[1] !== 1)
			console.error("Message with ID " + id + " was already present in the database.");
		callback();
	});
}

function getMessageId(time, text) {
	const hash = crypto.createHash('sha1');
	hash.update(Float64Array.of(time));
	hash.update(text);

	return hash.digest('base64').slice(0, -1); // removed the useless padding for those 20 bytes
}

function firstRedisError(arr) {
	let error;
	let i = arr.length;
	while (!error && i--)
		if (arr[i] instanceof RedisError)
			error = arr[i];

	return error;
}

function inspectQueue() {
	if (inspectingQueue) {
		// the procedure is already in progress, let it resume on its own
		resumeInspection = true;
		return;
	}

	// this has two purposes: being safe from concurrent modifications and grabbing every due message
	let dueTime = Math.max(nextDueTime, Date.now());
	let cb = (again) => {
		inspectingQueue = false;
		switch (true) {
			case resumeInspection:
				// just do it, with a new due time
				resumeInspection = false;
				dueTime = Math.max(nextDueTime, Date.now());
				process.nextTick(actuallyInspectQueue, cb);
				return;

			case again:
				// inspect again the queue after the message reservations have surely expired
				setTimeout(actuallyInspectQueue, PROCESSING_RETRY_DELAY, cb).unref();
				return;
		}

		// try to obtain and publish the new minimum due time
		db.watch(QUEUE, (error) => {
			if (error)
				return console.error(error, "\n>>> Could not prepare the publishing of the next due time.");

			db.zrange(QUEUE, 0, 0, 'WITHSCORES', (error, response) => {
				if (error)
					return console.error(error, "\n>>> Could not read the next message's due time.");

				let time;
				if (response.length)
					time = Number.parseInt(response[1], 10);
				db.multi()
					.publish(NEXT_DUE_TIME_CHANNEL, tools.numberToBuffer(time))
					.exec((error, responses) => {
						/* 
						 * If 'responses' is not defined, the transaction failed because someone else tampered with the
						 * message queue and it is up to them to publish the new minimum due time.
						 */
						if (!responses)
							return console.error("Someone else will have to publish the next due time.");

						if (responses[0] instanceof RedisError)
							error = responses[0];
						if (error)
							console.error(error, "\n>>> Could not publish the next due time.");
					});
			});
		});
	};

	actuallyInspectQueue(cb);

	function actuallyInspectQueue(cb) {
		inspectingQueue = true;
		let reverse;

		getBatch();

		function getBatch() {
			// yes, there's no error in reading always with offset 0
			db[reverse ? 'zrevrangebyscore' : 'zrangebyscore'](QUEUE, reverse ? dueTime : '-inf', reverse ? '-inf' : dueTime,
				'WITHSCORES', 'LIMIT', 0, PROCESSING_BATCH_SIZE, (error, response) => {
					if (resumeInspection)
						return cb();
					if (error) {
						console.error(error, "\n>>> Could not get a batch of messages.");
						return cb(true);
					}

					if (!response.length)
						return cb(); // no messages at all

					// cycle through the batch
					let leftovers;
					let i = 0;
					let c = (leftover) => {
						if (resumeInspection)
							return cb();

						leftovers = leftovers || leftover;
						i += 2;
						if (i < response.length)
							tryDequeuing(response[i], Number.parseInt(response[i + 1], 10), c);
						else {
							// the batch is processed
							if (response.length < PROCESSING_BATCH_SIZE * 2)
								return cb(leftovers); // it's the last batch

							// fetch (hopefully) another batch of messages
							reverse = !reverse;
							getBatch();
						}
					};

					tryDequeuing(response[i], Number.parseInt(response[i + 1], 10), c);
				});
		}
	}
}

// attempts to dequeue one message
function tryDequeuing(id, time, callback) {
	// reserve it
	db.set(LOCK_PREFIX + id, tools.EMPTY_BUFFER, 'PX', PROCESSING_WINDOW, 'NX', (error, response) => {
		if (error)
			console.error(error, "\n>>> Could not reserve a message.");
		if (error || response == null)
			return callback(true); // either encountered an error or could not obtain the lock

		// get the contents
		db.get(CONTENT_PREFIX + id, (error, response) => {
			if (error) {
				console.error(error, "\n>>> Could not get the contents of a message.");
				return callback(true);
			}
			if (response == null) {
				console.error("Message with ID " + id + " is missing, most probably it has just been processed.");
				return callback(true);
			}

			doTask(time, response);

			// clean up
			db.batch()
				.zrem(QUEUE, id)
				.del(CONTENT_PREFIX + id, LOCK_PREFIX + id)
				.exec((error, responses) => {
					// check for individual errors
					error = error || firstRedisError(responses);
					if (error)
						console.error(error, "\n>>> Could not clean up the message from the database.");
				});

			callback(); // eager return, as deletions will anyway take place before the next issued commands
		});
	});
}

// performs a scheduled task 
function doTask(time, text) {
	console.log(`[${new Date(time).toISOString()}] (${FORMATTER.format(Date.now() - time)}) ${text}`);
}