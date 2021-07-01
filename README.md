## Echoing service

### Description

This is a service that performs the dumb task of merely printing messages to the console 
at certain moments in future (as the past cannot be changed with the current technology
:wink:). Its API consists in only one endpoint:

    POST /echoAtTime?ts={unix_timestamp}
    {Message to be displayed}

|Parameter name|Type|Optional|Default value (when optional)|Explanation|
|:---:|:---:|:---:|:---:|:---|
|ts|query|:heavy_check_mark:|the current time|This is a UNIX timestamp, which means it indicates seconds after the UNIX epoch start. It doesn't need to be an integer. Past timestamps are accepted and, of course, honoured with delay.|
|:heavy_minus_sign:|body|||The message to be printed, having of at most 10.000 characters.| 

---
### Implementation

The messages get saved into a Redis database and taken from there when their time comes. Each 
message and its associated time to display are assigned an ID computed as a SHA-1 over 
both. As a consequence, repeated requests are easily identified and have no side effect.

#### Database setup
 
The Redis database acts not only as a repository, but also as a synchronization medium for the multiple 
instances of the service that may be running at the same time.
 
Each instance uses two database connections:
- one for saving and retrieving the messages received within HTTP requests

  The following keys are employed:
    * `msgq` : a sorted set, ordered by timestamp (in *milliseconds*) and containing message 
    IDs
    * `msg:`_`id`_ : simple keys containing the actual text of each message
    * `lk:`_`id`_ : volatile simple keys used to reserve a certain message before processing its 
    display
- one dedicated for subscribing to and receiving notifications about the change 
  of the next message due time

  A separate connection was needed because the Redis Pub/Sub system
  does not accept data related commands from a subscribed client. 
  
  This connection is basically intended to keep all instances up to date with respect 
  to the minimum score in the `msgq` sorted set. Each instance has a timer set to trigger a 
  little bit before this moment in time, depending on the detected latency of the 
  database.
  
Whenever an instance modifies the message queue in a way that affects the minimum score, it notifies
all the instances, __including itself__, about the next due time by publishing an 8-byte binary
representation of that number (in order to keep such messages short). Instances detect when the
subscribing connection is lost and upon its restoration they use the regular connection (if/when
it is available as well) to get the next due time.
  
#### Message processing

When the instance timer triggers, the process reads a limited number of queue entries
that have a score less than or equal to the known minimum score (or the current time,
if greater). For each such entry, the process reserves the exclusive right to work on it
by creating the volatile `lk:`_`id`_ key with the **`NX`** flag, then fetches the message 
text, prints it and finally deletes the entry related information from the database.

Each instance keeps retrieving and processing this batch until there's no more work to 
do. Another delayed run is done if other instances are detected to be processing 
the remaining messages.

Care has been taken so as to withstand various possible error conditions. Also, if the timer
triggers again while the message queue is under inspection, the processing is interrupted and 
resumed for a new minimum score.

To maximize concurrency, the window of expired or about-to-expire messages is read alternatively
from the low and high  ends of that message list. For the same purpose, the removal of data 
that belong to processed messages is performed *individually*, not after accumulation.
 
---
### Running

After executing

    npm install --production

in the current folder and at the very least configuring the database connection parameters within the 
`config.json` file, you can start the HTTP service by running

    node .

Mind that you can also alter the host and port that the service listens on, as well as the API itself.

---
### Fun facts

1. The timer used by service instances works with timeout periods longer than _2147483647_ milliseconds (nearly 25 days) 
   as it's the case with the standard Node.js timer.
1. If one tries to view the `ArrayBuffer` under a `Buffer` as a `Float64Array`, after 
  managing to specify the offset and length, one is made the acquaintance of a nice error:
  
        RangeError: start offset of Float64Array should be a multiple of 8

1. The **`ZREVRANGEBY*`** Redis operations take the limits in reverse order, i.e. the 
  high limit, followed by the low limit  :unamused:
