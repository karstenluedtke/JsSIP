const EventEmitter = require('events').EventEmitter;
const sdp_transform = require('sdp-transform');
const Logger = require('./Logger');
const JsSIP_C = require('./Constants');
const Exceptions = require('./Exceptions');
const Transactions = require('./Transactions');
const Utils = require('./Utils');
const Timers = require('./Timers');
const SIPMessage = require('./SIPMessage');
const Dialog = require('./Dialog');
const RequestSender = require('./RequestSender');
const RTCSession = require('./RTCSession');
const RTCSession_DTMF = require('./RTCSession/DTMF');
const RTCSession_Info = require('./RTCSession/Info');
const RTCSession_ReferNotifier = require('./RTCSession/ReferNotifier');
const RTCSession_ReferSubscriber = require('./RTCSession/ReferSubscriber');
const URI = require('./URI');

const logger = new Logger('RTCSession');

class DummyRTCConnection {
	constructor() {
		logger.debug('DummyRTCSession created');
		this.dummySDP = 'v=0\r\n';
		this.dummyOffer = { type: 'offer', sdp: this.dummySDP };
		this.dummyAnswer = { type: 'answer', sdp: this.dummySDP };
		this.sigstate = 'stable';
	}

	get connectionState() {
		logger.debug('DummyRTCSession.connectionState: connected');

		return 'connected';
	}

	get iceConnectionState() {
		logger.debug('DummyRTCSession.iceConnectionState: completed');

		return 'completed';
	}

	get iceGatheringState() {
		logger.debug('DummyRTCSession.iceGatheringState: complete');

		return 'complete';
	}

	get signalingState() {
		logger.debug(`DummyRTCSession.signalingState: ${this.sigstate}`);

		return this.sigstate;
	}

	get canTrickleIceCandidates() {
		logger.debug('DummyRTCSession.canTrickleIceCandidates: false');

		return false;
	}

	get localDescription() {
		logger.debug('DummyRTCSession.localDescription: dummy');

		return this.dummyOffer;
	}

	get currentLocalDescription() {
		logger.debug('DummyRTCSession.currentLocalDescription: dummy');

		return this.dummyOffer;
	}

	get pendingLocalDescription() {
		logger.debug('DummyRTCSession.pendingLocalDescription: dummy');

		return this.dummyOffer;
	}

	get currentRemoteDescription() {
		logger.debug('DummyRTCSession.currentRemoteDescription: dummy');

		return this.dummyAnswer;
	}

	addIceCandidate() {
		logger.debug('DummyRTCSession.addIceCandidate()');
	}

	addTrack() {
		logger.debug('DummyRTCSession.addTrack()');
	}

	addTransceiver() {
		logger.debug('DummyRTCSession.addTransceiver()');
	}

	createOffer() {
		logger.debug('DummyRTCSession.createOffer()');

		return new Promise((resolve, reject) => {
			resolve(this.dummyOffer);
		});
	}

	createAnswer() {
		logger.debug('DummyRTCSession.createAnswer()');

		return new Promise((resolve, reject) => {
			resolve(this.dummyAnswer);
		});
	}

	setLocalDescription(desc) {
		logger.debug('DummyRTCSession.setLocalDescription()');
		if (desc['type'] == 'answer') {
			this.sigstate = 'stable';
		} else if (desc['type'] == 'offer') {
			this.sigstate = 'have-local-offer';
		}

		return new Promise((resolve, reject) => {
			resolve(desc);
		});
	}

	setRemoteDescription(desc) {
		logger.debug('DummyRTCSession.setRemoteDescription()');
		if (desc['type'] == 'answer') {
			this.sigstate = 'stable';
		} else if (desc['type'] == 'offer') {
			this.sigstate = 'have-remote-offer';
		}

		return new Promise((resolve, reject) => {
			resolve(desc);
		});
	}

	getSenders() {
		logger.debug('DummyRTCSession.getSenders(): empty');

		return [];
	}

	getReceivers() {
		logger.debug('DummyRTCSession.getReceivers(): empty');

		return [];
	}

	getStats() {
		logger.debug('DummyRTCSession.getStats(): empty');
		const emptyStats = [];

		return new Promise((resolve, reject) => {
			resolve(emptyStats);
		});
	}

	close() {
		logger.debug('DummyRTCSession.close().');
	}
}

const C = RTCSession.C;

module.exports = class NonRTCSession extends RTCSession {
	constructor(ua) {
		super(ua);

		this.invite_body = '';
	}

	toString() {
		return `NonRTCSession id=${String(this.id)}, body=${String(
			this.invite_body
		)}`;
	}

	isWrongContentType(contentType) {
		return !(contentType && contentType.startsWith('application/'));
	}

	_createRTCConnection(pcConfig, rtcConstraints) {
		logger.debug('NonRTCSession.createRTCConnection: DummyRTCConnection');
		this._connection = new DummyRTCConnection();
	}

	/**
	 * Initial Request Sender
	 */
	_sendInitialRequest(mediaConstraints, rtcOfferConstraints, mediaStream) {
		logger.debug('NonRTCSession._sendInitialRequest: creating RequestSender');
		const request_sender = new RequestSender(this._ua, this._request, {
			onRequestTimeout: () => {
				this.onRequestTimeout();
			},
			onTransportError: () => {
				this.onTransportError();
			},
			// Update the request on authentication.
			onAuthenticated: request => {
				this._request = request;
			},
			onReceiveResponse: response => {
				this._receiveInviteResponse(response);
			},
		});

		logger.debug('NonRTCSession._sendInitialRequest: RequestSender created');

		// This Promise is resolved within the next iteration, so the app has now
		// a chance to set events such as 'peerconnection' and 'connecting'.
		Promise.resolve()
			// Get a stream if required.
			.then(() => {
				// A stream is given, let the app set events such as 'peerconnection' and 'connecting'.
				if (mediaStream) {
					logger.debug('NonRTCSession._sendInitialRequest: have mediaStream');

					return mediaStream;
				} else {
					this._localMediaStreamLocallyGenerated = true;

					logger.debug('NonRTCSession._sendInitialRequest: create mediaStream');

					return new MediaStream();
				}
			})
			.then(stream => {
				if (this._status === C.STATUS_TERMINATED) {
					throw new Error('terminated');
				}

				logger.debug('NonRTCSession._sendInitialRequest: storing mediaStream');
				this._localMediaStream = stream;
				this._request.body = this.invite_body;

				// TODO: should this be triggered here?
				logger.debug('NonRTCSession._sendInitialRequest: _connecting');
				this._connecting(this._request);

				this._status = C.STATUS_INVITE_SENT;

				logger.debug('emit "sending" [request:%o]', this._request);

				// Emit 'sending' so the app can mangle the body before the request is sent.
				this.emit('sending', {
					request: this._request,
				});

				this._initialExtraHeaders = this._request.extraHeaders;

				request_sender.send();
			})
			.catch(error => {
				if (this._status === C.STATUS_TERMINATED) {
					return;
				}

				logger.warn(error);
			});
	}

	/**
	 * Send Re-INVITE
	 */
	_sendReinvite(options = {}) {
		logger.debug('NonRTCSession.sendReinvite()');

		const extraHeaders = Utils.cloneArray(options.extraHeaders);
		const eventHandlers = Utils.cloneObject(options.eventHandlers);
		const rtcOfferConstraints =
			options.rtcOfferConstraints || this._rtcOfferConstraints || null;

		let succeeded = false;

		const knownHdrs = { contentType: 'Content-Type: application/sdp' };

		if (this._initialExtraHeaders) {
			this._initialExtraHeaders.forEach(hdr => {
				if (hdr && hdr.startsWith('Content-Type:')) {
					knownHdrs.contentType = hdr;
				} else if (hdr && hdr.startsWith('Content-Disposition:')) {
					knownHdrs.contentDisposition = hdr;
				}
			});
		}

		if (knownHdrs.contentDisposition) {
			extraHeaders.push(knownHdrs.contentDisposition);
		}
		extraHeaders.push(`Contact: ${this._contact}`);
		extraHeaders.push(knownHdrs.contentType);

		// Session Timers.
		if (this._sessionTimers.running) {
			extraHeaders.push(
				`Session-Expires: ${this._sessionTimers.currentExpires};refresher=${this._sessionTimers.refresher ? 'uac' : 'uas'}`
			);
		}

		this._connectionPromiseQueue = this._connectionPromiseQueue
			.then(() => this._createLocalDescription('offer', rtcOfferConstraints))
			.then(sdp => {
				sdp = this._mangleOffer(sdp);

				const e = { originator: 'local', type: 'offer', sdp };

				logger.debug('emit "sdp"');
				this.emit('sdp', e);

				this.sendRequest(JsSIP_C.INVITE, {
					extraHeaders,
					body: sdp,
					eventHandlers: {
						onSuccessResponse: response => {
							onSucceeded.call(this, response);
							succeeded = true;
						},
						onErrorResponse: response => {
							onFailed.call(this, response);
						},
						onTransportError: () => {
							this.onTransportError(); // Do nothing because session ends.
						},
						onRequestTimeout: () => {
							this.onRequestTimeout(); // Do nothing because session ends.
						},
						onDialogError: () => {
							this.onDialogError(); // Do nothing because session ends.
						},
					},
				});
			})
			.catch(() => {
				onFailed();
			});

		function onSucceeded(response) {
			if (this._status === C.STATUS_TERMINATED) {
				return;
			}

			this.sendRequest(JsSIP_C.ACK);

			// If it is a 2XX retransmission exit now.
			if (succeeded) {
				return;
			}

			// Handle Session Timers.
			this._handleSessionTimersInIncomingResponse(response);

			// Must have SDP answer.
			if (!response.body) {
				onFailed.call(this);

				return;
			} else if (
				!response.hasHeader('Content-Type') ||
				this.isWrongContentType(
					response.getHeader('Content-Type').toLowerCase()
				)
			) {
				onFailed.call(this);

				return;
			}

			const e = {
				originator: 'remote',
				type: 'answer',
				sdp: response.body,
				response: response,
			};

			logger.debug('emit "sdp"');
			this.emit('sdp', e);

			const answer = new RTCSessionDescription({ type: 'answer', sdp: e.sdp });

			this._connectionPromiseQueue = this._connectionPromiseQueue
				.then(() => this._connection.setRemoteDescription(answer))
				.then(() => {
					if (eventHandlers.succeeded) {
						eventHandlers.succeeded(response);
					}
				})
				.catch(error => {
					onFailed.call(this);

					logger.warn(
						'emit "peerconnection:setremotedescriptionfailed" [error:%o]',
						error
					);

					this.emit('peerconnection:setremotedescriptionfailed', error);
				});
		}

		function onFailed(response) {
			if (eventHandlers.failed) {
				eventHandlers.failed(response);
			}
			if (response && response.status_code) {
				if (response.status_code >= 400 && response.status_code != 488) {
					// In our case a failed reInvite is fatal
					this.onDialogError();
				}
			}
		}
	}

	/**
	 * Send UPDATE
	 */
	_sendUpdate(options = {}) {
		logger.debug('NonRTCSession.sendUpdate()');

		const extraHeaders = Utils.cloneArray(options.extraHeaders);
		const eventHandlers = Utils.cloneObject(options.eventHandlers);
		const rtcOfferConstraints =
			options.rtcOfferConstraints || this._rtcOfferConstraints || null;
		const sdpOffer = options.sdpOffer || false;

		let succeeded = false;

		const knownHdrs = { contentType: 'Content-Type: application/sdp' };

		if (this._initialExtraHeaders) {
			this._initialExtraHeaders.forEach(hdr => {
				if (hdr && hdr.startsWith('Content-Type:')) {
					knownHdrs.contentType = hdr;
				} else if (hdr && hdr.startsWith('Content-Disposition:')) {
					knownHdrs.contentDisposition = hdr;
				}
			});
		}

		if (knownHdrs.contentDisposition) {
			extraHeaders.push(knownHdrs.contentDisposition);
		}
		extraHeaders.push(`Contact: ${this._contact}`);

		// Session Timers.
		if (this._sessionTimers.running) {
			extraHeaders.push(
				`Session-Expires: ${this._sessionTimers.currentExpires};refresher=${this._sessionTimers.refresher ? 'uac' : 'uas'}`
			);
		}

		if (sdpOffer) {
			extraHeaders.push(knownHdrs.contentType);

			this._connectionPromiseQueue = this._connectionPromiseQueue
				.then(() => this._createLocalDescription('offer', rtcOfferConstraints))
				.then(sdp => {
					sdp = this._mangleOffer(sdp);

					const e = { originator: 'local', type: 'offer', sdp };

					logger.debug('emit "sdp"');
					this.emit('sdp', e);

					this.sendRequest(JsSIP_C.UPDATE, {
						extraHeaders,
						body: sdp,
						eventHandlers: {
							onSuccessResponse: response => {
								onSucceeded.call(this, response);
								succeeded = true;
							},
							onErrorResponse: response => {
								onFailed.call(this, response);
							},
							onTransportError: () => {
								this.onTransportError(); // Do nothing because session ends.
							},
							onRequestTimeout: () => {
								this.onRequestTimeout(); // Do nothing because session ends.
							},
							onDialogError: () => {
								this.onDialogError(); // Do nothing because session ends.
							},
						},
					});
				})
				.catch(() => {
					onFailed.call(this);
				});
		}

		// No SDP.
		else {
			this.sendRequest(JsSIP_C.UPDATE, {
				extraHeaders,
				eventHandlers: {
					onSuccessResponse: response => {
						onSucceeded.call(this, response);
					},
					onErrorResponse: response => {
						onFailed.call(this, response);
					},
					onTransportError: () => {
						this.onTransportError(); // Do nothing because session ends.
					},
					onRequestTimeout: () => {
						this.onRequestTimeout(); // Do nothing because session ends.
					},
					onDialogError: () => {
						this.onDialogError(); // Do nothing because session ends.
					},
				},
			});
		}

		function onSucceeded(response) {
			if (this._status === C.STATUS_TERMINATED) {
				return;
			}

			// If it is a 2XX retransmission exit now.
			if (succeeded) {
				return;
			}

			// Handle Session Timers.
			this._handleSessionTimersInIncomingResponse(response);

			// Must have SDP answer.
			if (sdpOffer) {
				if (!response.body) {
					onFailed.call(this);

					return;
				} else if (
					!response.hasHeader('Content-Type') ||
					this.isWrongContentType(
						response.getHeader('Content-Type').toLowerCase()
					)
				) {
					onFailed.call(this);

					return;
				}

				const e = { originator: 'remote', type: 'answer', sdp: response.body };

				logger.debug('emit "sdp"');
				this.emit('sdp', e);

				const answer = new RTCSessionDescription({
					type: 'answer',
					sdp: e.sdp,
				});

				this._connectionPromiseQueue = this._connectionPromiseQueue
					.then(() => this._connection.setRemoteDescription(answer))
					.then(() => {
						if (eventHandlers.succeeded) {
							eventHandlers.succeeded(response);
						}
					})
					.catch(error => {
						onFailed.call(this);

						logger.warn(
							'emit "peerconnection:setremotedescriptionfailed" [error:%o]',
							error
						);

						this.emit('peerconnection:setremotedescriptionfailed', error);
					});
			}
			// No SDP answer.
			else if (eventHandlers.succeeded) {
				eventHandlers.succeeded(response);
			}
		}

		function onFailed(response) {
			if (eventHandlers.failed) {
				eventHandlers.failed(response);
			}
		}
	}

	sendInfo(contentType, body, options = {}) {
		logger.debug('NonRTCSession.sendInfo()');

		// Check Session Status.
		if (
			this._status !== C.STATUS_CONFIRMED &&
			this._status !== C.STATUS_WAITING_FOR_ACK &&
			this._status !== C.STATUS_1XX_RECEIVED
		) {
			throw new Exceptions.InvalidStateError(this._status);
		}

		const info = new RTCSession_Info(this);

		if (typeof options?.eventHandlers?.succeeded === 'function') {
			info.on('succeeded', options.eventHandlers.succeeded);
		} else {
			info.on('succeeded', event => {
				logger.debug('NonRTCSession.sendInfo succeeded');
				if (event.response?.body) {
					const cthdr = event.response.hasHeader('Content-Type')
						? event.response.getHeader('Content-Type').toLowerCase()
						: undefined;

					if (cthdr && cthdr.startsWith(contentType)) {
						this.newInfo({
							info: info,
							...event,
						});
					} else {
						logger.warn(
							`NonRTCSession.sendInfo: response content type mismatch: ${cthdr} != ${contentType}`
						);
					}
				} else if (event.response) {
					logger.debug('NonRTCSession.sendInfo: no response body');
				}
			});
		}

		if (typeof options?.eventHandlers?.failed === 'function') {
			info.on('failed', options.eventHandlers.failed);
		} else {
			info.on('failed', event => {
				logger.debug('NonRTCSession.sendInfo failed');
			});
		}

		info.send(contentType, body, options);
	}
};
