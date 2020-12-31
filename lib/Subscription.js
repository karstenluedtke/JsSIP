const EventEmitter = require('events').EventEmitter;
const Utils = require('./Utils');
const JsSIP_C = require('./Constants');
const SIPMessage = require('./SIPMessage');
const RequestSender = require('./RequestSender');
const debug = require('debug')('JsSIP:Subscription');

const MIN_SUBSCRIBE_EXPIRES = 10; // In seconds.

module.exports = class Subscription extends EventEmitter
{
  constructor(ua, target, event, transport)
  {
    super();

    this._ua = ua;
    this._transport = transport;

    this._event = event;
    this._subsuri = ua.normalizeTarget(target);
    this._expires = ua.configuration.register_expires;
    this._refresh = false;

    // Call-ID and CSeq values RFC3261 10.2.
    this._call_id = Utils.createRandomToken(22);
    this._from_tag = Utils.newTag();
    this._id = this._call_id + this._from_tag;
    this._cseq = 0;

    this._to_uri = this._subsuri;

    this._subscriptionRefresh = 0;
    this._subscriptionTimer = null;

    // Ongoing Register request.
    this._subscribing = false;

    // Set status.
    this._state = 'TRYING';
    this._active = false;
    this._accepted = false;

    // Contact header.
    this._contact = this._ua.contact.toString();

    // Custom headers for SUBSCRIBE and un-SUBSCRIBE.
    this._extraHeaders = [];

    debug('Subscription initialized');
  }

  get id()
  {
    return this._id;
  }

  get state()
  {
    return this._state;
  }

  get active()
  {
    return this._accepted && this._active;
  }

  isEnded()
  {
    return !this._subscribing && !this._accepted;
  }

  setExtraHeaders(extraHeaders)
  {
    if (! Array.isArray(extraHeaders))
    {
      extraHeaders = [];
    }

    this._extraHeaders = extraHeaders.slice();
  }

  subscribe(options)
  {
    debug('subscribe...');
    if (options && options.expires && (options.expires >= 90)) {
        this._expires = options.expires;
    }
    if (options && options.refresh) {
        this._refresh = options.refresh;
    }
    if (options && options.extraHeaders) {
        this.setExtraHeaders(options.extraHeaders);
    }

    if (this._subscribing)
    {
      debug('Register request in progress...');

      return;
    }

    const extraHeaders = this._extraHeaders.slice();

    extraHeaders.push(`Event: ${this._event}`);
    extraHeaders.push(`Contact: ${this._contact}`);
    extraHeaders.push(`Expires: ${this._expires}`);

    if (options.eventHandlers)
    {
      const handlers = options.eventHandlers;
      for (const event in handlers)
      {
        if (Object.prototype.hasOwnProperty.call(handlers, event))
        {
          this.on(event, handlers[event]);
        }
      }
    }

    debug('creating SUBSCRIBE request...', this._subsuri, this._to_uri,
          this._from_tag, this._call_id, this._cseq + 1);
    const request = new SIPMessage.OutgoingRequest(
      JsSIP_C.SUBSCRIBE, this._subsuri, this._ua, {
        'to_uri'  : this._to_uri,
        'from_tag': this._from_tag,
        'call_id' : this._call_id,
        'cseq'    : (this._cseq += 1)
      }, extraHeaders);

    debug('creating request sender...');
    const request_sender = new RequestSender(this._ua, request, {
      onRequestTimeout : () =>
      {
        this._subscriptionFailure(null, JsSIP_C.causes.REQUEST_TIMEOUT);
      },
      onTransportError : () =>
      {
        this._subscriptionFailure(null, JsSIP_C.causes.CONNECTION_ERROR);
      },
      // Increase the CSeq on authentication.
      onAuthenticated : () =>
      {
        this._cseq += 1;
      },
      onReceiveResponse : (response) =>
      {
        // Discard responses to older SUBSCRIBE/un-SUBSCRIBE requests.
        if (response.cseq !== this._cseq)
        {
          return;
        }

        // Clear subsciption timer.
        if (this._subscriptionTimer !== null)
        {
          clearTimeout(this._subscriptionTimer);
          this._subscriptionTimer = null;
        }

        switch (true)
        {
          case /^1[0-9]{2}$/.test(response.status_code):
          {
            // Ignore provisional responses.
            break;
          }

          case /^2[0-9]{2}$/.test(response.status_code):
          {
            this._subscribing = false;

            let expires = response.getHeader('expires');

            if (!expires)
            {
              expires = this._expires;
            }

            this.scheduleRefreshTimer(Number(expires));

            if (! this._accepted)
            {
              const data = { originator: 'remote', response: response };
              this._state = 'ACCEPTED';
              this._accepted = true;
              this._ua.newSubscription(this);
              this.emit('accepted', data);
            }

            break;
          }

          default:
          {
            const cause = Utils.sipErrorCause(response.status_code);

            this._subscriptionFailure(response, cause);
          }
        }
      }
    });

    debug('sending request...');
    this._subscribing = true;
    request_sender.send();
    debug('SUBSCRIBE request sent.');
  }

  scheduleRefreshTimer(seconds)
  {
    if (this._subscriptionTimer !== null)
    {
      clearTimeout(this._subscriptionTimer);
      this._subscriptionTimer = null;
    }

    if (seconds < MIN_SUBSCRIBE_EXPIRES)
      seconds = MIN_SUBSCRIBE_EXPIRES;

    const timeout = seconds > 64
      ? (seconds * 1000 / 2) +
        Math.floor(((seconds / 2) - 32) * 1000 * Math.random())
      : (seconds * 1000) - 5000;

    // Re-Subscribe or emit an event before the expiration interval has elapsed.
    // For that, decrease the expires value. ie: 3 seconds.
    debug('resubscribing in ', timeout, 'ms');
    this._subscriptionRefresh = Date.now() + timeout;
    this._subscriptionTimer = setTimeout(() =>
    {
      this._subscriptionTimer = null;
      // If there are no listeners for subscriptionExpiring, renew subscription.
      // If there are listeners, let the function listening do the subscribe call.
      if (this.listeners('subscriptionExpiring').length > 0)
      {
        this.emit('subscriptionExpiring', {originator: 'local'});
      }
      else if (this._refresh)
      {
        this.subscribe();
      }
    }, timeout);
  }

  /**
   * In dialog Request Reception
   */
  receiveRequest(request)
  {
    debug('receiveRequest()');

    if (request.method === JsSIP_C.NOTIFY)
    {
      debug('receiveRequest(): NOTIFY');
      const ctype = request.getHeader('Content-Type');
      const data = { originator: 'remote',
                     request: request,
                     info: { contentType: ctype, body: request.body } };
      if (this._accepted && !this._active)
      {
        this._active = true;
        this.emit('confirmed', data);
      }
      let subsState = request.getHeader('Subscription-State');
      if (subsState)
      {
        let semi = subsState.indexOf(';');
        if (semi > 0)
        {
          this._state = subsState.substr(0, semi).trim().toUpperCase();

          let epos = subsState.indexOf('expires=', semi);
          if ((epos > semi) && (this._state === "ACTIVE"))
          {
            let expires = parseInt(subsState.substr(epos + 8));
            let refresh = Date.now() + 1000 * expires - 3000;
            if (refresh < this._subscriptionRefresh)
              this.scheduleRefreshTimer(expires);
          }
        } else {
          this._state = subsState.trim().toUpperCase();
        }
      }

      debug('emitting notify event');
      this.emit('notify', data);

      if (this._state === "TERMINATED")
      {
        if (this._subscriptionTimer !== null)
        {
          clearTimeout(this._subscriptionTimer);
          this._subscriptionTimer = null;
        }
        this._unsubscribed(request, 'Terminated');
      }
    }
  }

  unsubscribe(options = {})
  {
    if (this.isEnded())
    {
      debug('already unsubscribed');

      return;
    }

    this._state = 'TERMINATED';
    this._active = false;
    this._accepted = false;

    // Clear the subscription timer.
    if (this._subscriptionTimer !== null)
    {
      clearTimeout(this._subscriptionTimer);
      this._subscriptionTimer = null;
    }

    const extraHeaders = this._extraHeaders.slice();

    extraHeaders.push(`Contact: ${this._contact}`);
    extraHeaders.push('Expires: 0');

    const request = new SIPMessage.OutgoingRequest(
      JsSIP_C.SUBSCRIBE, this._subsuri, this._ua, {
        'to_uri'  : this._to_uri,
        'from_uri': this._from_uri,
        'call_id' : this._call_id,
        'cseq'    : (this._cseq += 1)
      }, extraHeaders);

    const request_sender = new RequestSender(this._ua, request, {
      onRequestTimeout : () =>
      {
        this._unsubscribed(null, JsSIP_C.causes.REQUEST_TIMEOUT);
      },
      onTransportError : () =>
      {
        this._unsubscribed(null, JsSIP_C.causes.CONNECTION_ERROR);
      },
      // Increase the CSeq on authentication.
      onAuthenticated : () =>
      {
        this._cseq += 1;
      },
      onReceiveResponse : (response) =>
      {
        switch (true)
        {
          case /^1[0-9]{2}$/.test(response.status_code):
            // Ignore provisional responses.
            break;
          case /^2[0-9]{2}$/.test(response.status_code):
            this._unsubscribed(response);
            break;
          default:
          {
            const cause = Utils.sipErrorCause(response.status_code);

            this._unsubscribed(response, cause);
          }
        }
      }
    });

    request_sender.send();
  }

  terminate(options = {})
  {
    debug('terminate()');
    unsubscribe(options);
  }

  close()
  {
    if (this._active)
    {
      this.unsubscribed();
    }
  }


  onTransportClosed()
  {
    this._subscribing = false;
    if (this._subscriptionTimer !== null)
    {
      clearTimeout(this._subscriptionTimer);
      this._subscriptionTimer = null;
    }

    if (this._active)
    {
      this._active = false;
      this._unsubscribed(null, JsSIP_C.causes.CONNECTION_ERROR);
    }
  }

  _subscriptionFailure(response, cause)
  {
    this._subscribing = false;

    if (this._active)
    {
      this._active = false;
      this._unsubscribed(response, cause);
    }
  }

  _unsubscribed(response, cause)
  {
    const data = { originator: ((response && cause) ? 'remote': 'local'),
                   message: response, cause: cause };
    debug('unsubscribed ' + (data.message || 'no response')
                    + ' ' + (data.cause || 'unknown cause'));
    this._state = 'TERMINATED';
    this._subscribing = false;
    this._active = false;
    this.emit('ended', data);
    this._ua.destroySubscription(this);
  }
};
