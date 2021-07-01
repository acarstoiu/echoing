/*
 * Generally useful stuff
 */

'use strict';

const LE_OR_BE = require('os').endianness();

module.exports = {
	mustBeFunction,
	mustBeNumber,

	getDefaultLocale,
	numberToBuffer,
	bufferToNumber,
	EMPTY_BUFFER: Buffer.from(""),

	installExitFunction,
	exit
};

function mustBeFunction(arg) {
	if (typeof arg !== 'function')
		throw new TypeError("A function was expected, not '" + arg + "'.");
}

function mustBeNumber(arg, finite) {
	if (typeof arg !== 'number' || finite && !Number.isFinite(arg))
		throw new TypeError("A" + (finite ? " finite" : "") + " number was expected, not '" + arg + "'.");
}

function getDefaultLocale() {
	return new Intl.NumberFormat().resolvedOptions().locale;
}

// CAUTION: conversion between 'Number' and 'Buffer' assumes that both sides are of the same endianness!
const readNumber = "readDouble" + LE_OR_BE; // hopefully optimized
const writeNumber = "writeDouble" + LE_OR_BE; // hopefully optimized

function numberToBuffer(number) {
	if (number == null)
		return module.exports.EMPTY_BUFFER;

	mustBeNumber(number);
	const buffer = Buffer.allocUnsafe(8);
	buffer[writeNumber](number);
	return buffer;
}

function bufferToNumber(buffer) {
	if (!(buffer instanceof Buffer))
		throw new TypeError("A Buffer was expected, not '" + buffer + "'.");

	return buffer.length ? buffer[readNumber]() : null;
}

let exitFunc;

function installExitFunction(func) {
	mustBeFunction(func);
	exitFunc = func;

	process.on('SIGINT', exit);
	process.on('SIGTERM', exit);
	process.on('SIGBREAK', exit);
	process.on('SIGHUP', exit);
}

function exit() {
	if (exitFunc)
		exitFunc(...arguments);
	else process.exit();
}