/*
 * This service simply prints messages to the console, but synchronizes in this endeavour
 * with other possible instances of its own via Redis.
 *
 * Its single endpoint is
 *		POST /echoAtTime?ts={unix_timestamp}
 * with the body carring the message to echo.
 */

'use strict';

const http = require('http');

const ct = require('content-type');

const q = require("./queue");
void require("./toolbox").installExitFunction(exit);
const config = require("./config.json");

const URL_BASE = "http://host"; // conventional base for the request's URL
const MEDIA_TYPE_PREFIX = 'text/';

let server;

// set up the message storage
q.setUp((error) => {
	if (error) {
		console.error("Unable to set up the storage.");
		exit(error);
	}

	// start listening on HTTP
	server = http.createServer((request, response) => {
		// verify the request against the sole endpoint
		const url = new URL(request.url, URL_BASE);
		if (url.pathname !== config.service.path)
			return replyWithError(404); // wrong path
		if (request.method !== config.service.method)
			return replyWithError(405); // wrong method

		// extract the message display time
		let ts;
		if (url.searchParams.has(config.service.timeParameter)) {
			ts = Number.parseFloat(url.searchParams.get(config.service.timeParameter));
			if (Number.isNaN(ts))
				return replyWithError();
			ts = Math.round(ts * 1000); // for an integer number of milliseconds

			if (ts < Date.now())
				console.error("Received a message that should have been processed in the past.");
		}
		else ts = Date.now(); // print the message immediately, in the absence of a timestamp

		// extract its contents
		let encoding, mediaType;
		if (request.headers['content-type']) {
			try {
				mediaType = ct.parse(request.headers['content-type']);
			}
			catch (e) {
			}
			if (!mediaType || !mediaType.type.startsWith(MEDIA_TYPE_PREFIX))
				return replyWithError(); // wrong content type
			encoding = mediaType.parameters.charset;
			if (encoding && !Buffer.isEncoding(encoding))
				return replyWithError(); // unsupported encoding
		}

		let body = "";
		request.setEncoding(encoding || 'utf8');
		request.on('data', (chunk) => {
			if (body.length + chunk.length > config.service.maxMessageLength)
				replyWithError(413);
			else body += chunk;
		});
		request.on('end', () => {
			if (!request.complete || !body.length) // reject empty messages, too
				return replyWithError();

			q.enqueue(ts, body, (error) => {
				if (error) {
					console.error(error);
					return replyWithError(500);
				}

				response.statusCode = 200;
				response.end();
			});
		});
		request.on('error', replyWithError);

		function replyWithError(code) {
			request.removeAllListeners('data'); // let it flow to nowhere
			response.statusCode = code || 400;
			response.end();
		}
	});

	server.on('error', (error) => {
		console.error("Unable to listen on " + config.attachment.host + ":" + config.attachment.port + ".");
		exit(error);
	});

	server.listen(config.attachment.port, config.attachment.host);
});

// gracefully terminates the service
function exit(error) {
	server.close(() => {
		q.shutDown(() => {
			if (error)
				throw error; // mind that it could be the name of a signal

			process.exit();
		});
	});
}