const JsSIP_C = require('../Constants');
const Transactions = require('../Transactions');
const RequestSender = require('../RequestSender');
const Logger = require('../Logger');

// Default event handlers.
const EventHandlers = {
	onRequestTimeout: () => {},
	onTransportError: () => {},
	onSuccessResponse: () => {},
	onErrorResponse: () => {},
	onAuthenticated: () => {},
	onDialogError: () => {},
};

const logger = new Logger("DialogRequestSender");

module.exports = class DialogRequestSender {
	constructor(dialog, request, eventHandlers) {
		this._dialog = dialog;
		this._ua = dialog._ua;
		this._request = request;
		this._eventHandlers = eventHandlers;

		// RFC3261 14.1 Modifying an Existing Session. UAC Behavior.
		this._reattempt = false;
		this._reattemptTimer = null;

		// Define the undefined handlers.
		for (const handler in EventHandlers) {
			if (Object.prototype.hasOwnProperty.call(EventHandlers, handler)) {
				if (!this._eventHandlers[handler]) {
					this._eventHandlers[handler] = EventHandlers[handler];
				}
			}
		}
	}

	get request() {
		return this._request;
	}

	send() {
		const request_sender = new RequestSender(this._ua, this._request, {
			onRequestTimeout: () => {
				this._eventHandlers.onRequestTimeout();
			},
			onTransportError: () => {
				this._eventHandlers.onTransportError();
			},
			onAuthenticated: request => {
				this._eventHandlers.onAuthenticated(request);
			},
			onReceiveResponse: response => {
				this._receiveResponse(response);
			},
		});

		request_sender.send();

		// RFC3261 14.2 Modifying an Existing Session -UAC BEHAVIOR-.
		if (
			(this._request.method === JsSIP_C.INVITE ||
				(this._request.method === JsSIP_C.UPDATE && this._request.body)) &&
			request_sender.clientTransaction.state !==
				Transactions.C.STATUS_TERMINATED
		) {
			this._dialog.uac_pending_reply = true;

			const stateChanged = () => {
				if (
					request_sender.clientTransaction.state ===
						Transactions.C.STATUS_ACCEPTED ||
					request_sender.clientTransaction.state ===
						Transactions.C.STATUS_COMPLETED ||
					request_sender.clientTransaction.state ===
						Transactions.C.STATUS_TERMINATED
				) {
					request_sender.clientTransaction.removeListener(
						'stateChanged',
						stateChanged
					);
					this._dialog.uac_pending_reply = false;
				}
			};

			request_sender.clientTransaction.on('stateChanged', stateChanged);
		}
	}

	_receiveResponse(response) {
		// RFC3261 12.2.1.2 408 or 481 is received for a request within a dialog.
		if (response.status_code === 408 || response.status_code === 481) {
			this._eventHandlers.onDialogError(response);
		} else if (
			response.method === JsSIP_C.INVITE &&
			response.status_code === 491
		) {
			if (this._reattempt) {
				logger.warn("receiveResponse: received 491 once again");
				this._eventHandlers.onErrorResponse(response);
			} else {
				const sess = this._dialog.owner;
				// rfc3261, 14.1, UAC receives 491, case 1. or 2.
				let tmo = (sess?.direction == 'outgoing')? 2100: 100;
				tmo = Math.floor(tmo + 1900 * Math.random());
				logger.debug("receiveResponse: received 491: " + JSON.stringify({
										 cseq: response?.cseq,
										 sess_direction: sess?.direction, tmo,
										 signalingState: sess?.connection?.signalingState }));
				this._reattemptTimer = setTimeout(() => {
					if (!this._dialog.isTerminated()) {
						if (this._request.body &&
								(this._request.body.indexOf('\no=') > 0) &&
								(sess?.connection?.signalingState != 'have-local-offer')) {
							logger.warn("another sdp exchange occurred after 491: " +
													JSON.stringify({ cseq: response?.cseq,
													signalingState: sess?.connection?.signalingState }));
							return;
						}
						this._reattempt = true;
						this._request.cseq = (this._dialog.local_seqnum += 1);
						this._request.setHeader('cseq', `${this._request.cseq} ${this._request.method}`);
						logger.debug("second attempt on 491: " + JSON.stringify({
												 cseq: response?.cseq,
												 request_cseq: this._request?.cseq,
												 local_seqnum: this._dialog?.local_seqnum,
												 signalingState: sess?.connection?.signalingState }));
						this.send();
					}
				}, tmo);
			}
		} else if (response.status_code >= 200 && response.status_code < 300) {
			this._eventHandlers.onSuccessResponse(response);
		} else if (response.status_code >= 300) {
			this._eventHandlers.onErrorResponse(response);
		}
	}
};
