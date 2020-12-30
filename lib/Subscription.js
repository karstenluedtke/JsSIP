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
    this._cseq = 0;

    this._to_uri = this._subsuri;

    this._subscriptionTimer = null;

    // Ongoing Register request.
    this._subscribing = false;

    // Set status.
    this._active = false;
    this._accepted = false;

    // Contact header.
    this._contact = this._ua.contact.toString();

    // Custom headers for SUBSCRIBE and un-SUBSCRIBE.
    this._extraHeaders = [];

    debug('Subscription initialized');
  }

  get active()
  {
    return this._active;
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

            if (!response.hasHeader('Contact'))
            {
              debug('no Contact header in response to SUBSCRIBE, response ignored');

              break;
            }

            const contacts = response.headers['Contact']
              .reduce((a, b) => a.concat(b.parsed), []);

            // Get the Contact pointing to us and update the expires value accordingly.
            const contact = contacts.find((element) => (
              element.uri.user === this._ua.contact.uri.user
            ));

            if (!contact)
            {
              debug('no Contact header pointing to us, response ignored');

              break;
            }

            let expires = contact.getParam('expires');

            if (!expires && response.hasHeader('expires'))
            {
              expires = response.getHeader('expires');
            }

            if (!expires)
            {
              expires = this._expires;
            }

            expires = Number(expires);

            if (expires < MIN_SUBSCRIBE_EXPIRES)
              expires = MIN_SUBSCRIBE_EXPIRES;

            const timeout = expires > 64
              ? (expires * 1000 / 2) +
                Math.floor(((expires / 2) - 32) * 1000 * Math.random())
              : (expires * 1000) - 5000;

            // Re-Register or emit an event before the expiration interval has elapsed.
            // For that, decrease the expires value. ie: 3 seconds.
            this._subscriptionTimer = setTimeout(() =>
            {
              this._subscriptionTimer = null;
              // If there are no listeners for subscriptionExpiring, renew subscription.
              // If there are listeners, let the function listening do the subscribe call.
              if (this._ua.listeners('subscriptionExpiring').length === 0)
              {
                this.subscribe();
              }
              else
              {
                this._ua.emit('subscriptionExpiring');
              }
            }, timeout);

            if (! this._active)
            {
              this._active = true;
              //this._ua.registered({ response });
            }

            break;
          }

          // Interval too brief RFC3261 10.2.8.
          case /^423$/.test(response.status_code):
          {
            if (response.hasHeader('min-expires'))
            {
              // Increase our subscription interval to the suggested minimum.
              this._expires = Number(response.getHeader('min-expires'));

              if (this._expires < MIN_SUBSCRIBE_EXPIRES)
                this._expires = MIN_SUBSCRIBE_EXPIRES;

              // Attempt the subscribe again immediately.
              this.subscribe();
            }
            else
            { // This response MUST contain a Min-Expires header field.
              debug('423 response received for SUBSCRIBE without Min-Expires');

              this._subscriptionFailure(response, JsSIP_C.causes.SIP_FAILURE_CODE);
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

  unsubscribe(options = {})
  {
    if (!this._active)
    {
      debug('already unsubscribed');

      return;
    }

    this._active = false;

    // Clear the subscription timer.
    if (this._subscriptionTimer !== null)
    {
      clearTimeout(this._subscriptionTimer);
      this._subscriptionTimer = null;
    }

    const extraHeaders = this._extraHeaders.slice();

    if (options.all)
    {
      extraHeaders.push(`Contact: *${this._extraContactParams}`);
    }
    else
    {
      extraHeaders.push(`Contact: ${this._contact};expires=0${this._extraContactParams}`);
    }

    extraHeaders.push('Expires: 0');

    const request = new SIPMessage.OutgoingRequest(
      JsSIP_C.SUBSCRIBE, this._subsuri, this._ua, {
        'to_uri'  : this._to_uri,
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
      this._unsubscribed(response, cause);
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
    debug('unsubscribed ' + (response || 'no response')
                    + ' ' + (cause || 'unknown cause'));
    this._subscribing = false;
    this._active = false;
    //this._ua.unregistered({
    //  response : response || null,
    //  cause    : cause || null
    //});
  }
};
