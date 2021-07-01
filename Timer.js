'use strict';

const tools = require("./toolbox");

const MAX_TIMEOUT = 0x7FFFFFFF;

/**
 * Implements a reprogrammable timer that is immune to the duration limitation in the standard API. 
 */
class Timer {
	/**
	 * Builds a timer that executes the <code>func</code> function when triggered.
	 * @param {function} func the function to execute, without passing any arguments
	 * @param {boolean} persistent indicates that this object should keep the event loop alive if it has
	 *			work to do in future 
	 */
	constructor(func, persistent) {
		tools.mustBeFunction(func);
		this.func = () => {
			this.timer = null;
			this.triggerTime = null;
			func();
		};
		this.triggerTime = null;
		this.timer = null;
		this.unref = !persistent; // implicit conversion to boolean 
	}

	/**
	 * Triggers the timer at the specified <code>time</code>, in milliseconds from the UNIX epoch time.
	 */
	trigger(time) {
		tools.mustBeNumber(time, true);
		if (time === this.triggerTime)
			return; // no actual change
		this.triggerTime = time;
		if (this.timer)
			this.timer.clearTimeout();

		const schedule = () => {
			// (re)compute the delay
			const delay = time - Date.now();
			if (delay < 1)
				return process.nextTick(this.func); // it's already late

			this.timer = delay > MAX_TIMEOUT ? setTimeout(schedule, MAX_TIMEOUT) : setTimeout(this.func, delay);
			if (this.unref)
				this.timer.unref();
		};

		schedule();
	}

	/**
	 * Cancels the timer.
	 */
	cancel() {
		this.triggerTime = null;
		if (this.timer) {
			this.timer.clearTimeout();
			this.timer = null;
		}
	}
}

module.exports = Timer;
