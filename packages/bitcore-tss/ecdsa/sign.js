import assert from 'assert';
import { DklsDsg, DklsTypes, DklsUtils } from '@bitgo/sdk-lib-mpc';
import { DklsComms } from './dklsComms.js';
import bitcoreLib from 'bitcore-lib';
import { encrypt, decrypt } from './utils.js';

export class Sign {
  #keychain;
  #partyId;
  #partySize;
  #minSigners;
  #derivationPath;
  #messageHash;
  #round;
  #authKey;
  #dsg;
  #signature;

  /**
   * 
   * @param {Object} params
   * @param {Object} params.keychain - keychain object generated by the KeyGen class
   * @param {Buffer} params.keychain.privateKeyShare 
   * @param {Buffer} params.keychain.commonKeyChain
   * @param {number} params.partyId - party id of the signer
   * @param {number} params.n - total number of participants
   * @param {number} params.m - number of participants required to sign
   * @param {string} params.derivationPath - OPTIONAL derivation path of the key to sign
   * @param {Buffer} params.messageHash - hash of the message to sign
   * @param {Buffer} params.authKey - authentication key of the signer
   * @param {number} params.round - round number of the signing process. This should not be explicitly given.
   */
  constructor({ keychain, partyId, n, m, derivationPath, messageHash, authKey, round }) {
    assert(keychain != null, 'keychain is required');
    assert(partyId != null, 'partyId is required');
    assert(n != null, 'n is required');
    assert(m != null, 'm is required');
    assert(messageHash != null, 'messageHash is required');
    assert(authKey != null, 'authKey is required');

    assert(Buffer.isBuffer(keychain.privateKeyShare), 'keychain.privateKeyShare must be a buffer');
    assert(Buffer.isBuffer(keychain.commonKeyChain), 'keychain.commonKeyChain must be a buffer');
    this.#keychain = keychain;

    assert(partyId >= 0 && partyId < n, 'partyId must be in the range [0, n-1]');
    this.#partyId = parseInt(partyId);

    assert(n > 1, 'n must be at least 2');
    this.#partySize = parseInt(n);

    assert(m > 0 && m <= this.#partySize, 'm must be in the range [1, n]');
    this.#minSigners = parseInt(m);

    assert(derivationPath == null || (typeof derivationPath === 'string' && derivationPath.startsWith('m')), 'derivationPath must be a string starting with "m"');
    this.#derivationPath = derivationPath || 'm';

    assert(Buffer.isBuffer(messageHash) && messageHash.length === 32, 'messageHash must be a 32 byte buffer');
    this.#messageHash = messageHash;

    assert(round == null || (round >= 0 && round <= 5), 'round must be in the range [0, 5]');
    this.#round = parseInt(round) || 0;

    this.#authKey = new bitcoreLib.PrivateKey(authKey);
    assert(this.#authKey.toString('hex') === authKey.toString('hex') || this.#authKey.toWIF() === authKey, 'Unrecognized authKey format');

    this.#dsg = new DklsDsg.Dsg(this.#keychain.privateKeyShare, this.#partyId, this.#derivationPath, this.#messageHash);
  }

  /**
   * Export the signing session to a base64 encoded string
   * @returns {string} Base64 encoded session string
   */
  export() {
    assert(this.#round > 0, 'Cannot export a session that has not started');
    assert(!this.isSignatureReady(), 'Cannot export a completed session. The signature is ready with getSignature()');
    
    const sessionBytes = this.#dsg.dsgSessionBytes || this.#dsg.dsgSession?.toBytes();
    const payload = this.#round +
      ':' + this.#partySize +
      ':' + this.#minSigners +
      ':' + this.#partyId +
      ':' + this.#derivationPath +
      ':' + Buffer.from(sessionBytes).toString('base64') +
      ':' + this.#messageHash.toString('base64');
    const buf = encrypt(Buffer.from(payload, 'utf8'), this.#authKey.publicKey, this.#authKey);
    return buf.toString('base64');
  }

  /**
   * Restore a signing session from an exported session
   * @param {Object} params
   * @param {string} params.session Base64 encoded session string
   * @param {Keychain} params.keychain Keychain to use for signing
   * @param {bitcoreLib.PrivateKey} params.authKey Private key to use for decrypting the session
   * @returns {Sign}
   */
  static async restore({ session, keychain, authKey }) {
    const _authKey = new bitcoreLib.PrivateKey(authKey);
    assert(_authKey.toString('hex') === authKey.toString('hex') || _authKey.toWIF() === authKey, 'Unrecognized authKey format');
    session = decrypt(Buffer.from(session, 'base64'), _authKey.publicKey, _authKey).toString('utf8');
    const [
      round,
      partySize,
      minSigners,
      partyId,
      derivationPath,
      dsgSessionBytes,
      messageHash,
    ] = session.split(':');
    const signer = new Sign({
      keychain,
      n: parseInt(partySize),
      m: parseInt(minSigners),
      partyId: parseInt(partyId),
      derivationPath,
      messageHash: Buffer.from(messageHash, 'base64'),
      authKey,
      round: parseInt(round)
    });
    await signer.#dsg.setSession(Buffer.from(dsgSessionBytes, 'base64'));
    return signer;
  }

  /**
   * @private
   * Format the message to be sent to the other parties
   * @param {Object} signedMessage
   * @returns 
   */
  _formatMessage(signedMessage) {
    return {
      round: this.#round++,
      partyId: this.#partyId,
      publicKey: this.#authKey.publicKey.toString(),
      p2pMessages: signedMessage.p2pMessages,
      broadcastMessages: signedMessage.broadcastMessages,
    };
  }

  /**
   * Initialize the signing session with a broadcast message to send to the other participants
   * @returns {Promise<{round: number, partyId: number, publicKey: string, p2pMessages: Object[], broadcastMessages: Object[]}>}
   */
  async initJoin() {
    assert(this.#round == 0, 'initJoin must be called before the rounds ');
    const unsignedMessageR1 = await this.#dsg.init();
    const serializedMsg = DklsTypes.serializeBroadcastMessage(unsignedMessageR1);
    const signedMessage = await DklsComms.encryptAndAuthOutgoingMessages(
      { broadcastMessages: [serializedMsg], p2pMessages: [] },
      [],
      this.#authKey
    );

    return this._formatMessage(signedMessage);
  }

  /**
   * Call this after receiving the initJoin broadcast messages from the other participants
   *  and while isSignatureReady() is false
   * @param {Array<Object>} prevRoundMessages 
   * @returns {{ round: number, partyId: number, publicKey: string, p2pMessages: Object[], broadcastMessages: Object[] }}
   */
  nextRound(prevRoundMessages) {
    assert(this.#round > 0, 'initJoin must be called before participating in the rounds');
    assert(this.#round < 5, 'Signing rounds are over');
    assert(Array.isArray(prevRoundMessages), 'prevRoundMessages must be an array');
    assert(prevRoundMessages.length === this.#minSigners - 1, 'Not ready to proceed to the next round');
    assert(prevRoundMessages.every(msg => msg.round === this.#round - 1), 'All messages must be from the previous round');
    assert(prevRoundMessages.every(msg => msg.partyId !== this.#partyId), 'Messages must not be from the yourself');

    let prevRndMsg = DklsComms.decryptAndVerifyIncomingMessages(prevRoundMessages, this.#authKey);
    prevRndMsg = DklsTypes.deserializeMessages(prevRndMsg);

    const thisRoundMsg = this.#dsg.handleIncomingMessages(prevRndMsg);
    const thisRoundMessage = DklsTypes.serializeMessages(thisRoundMsg);

    const partyPubKeys = prevRoundMessages.map(m => ({ partyId: m.partyId, publicKey: m.publicKey }));
    const signedMessage = DklsComms.encryptAndAuthOutgoingMessages(
      thisRoundMessage,
      partyPubKeys,
      this.#authKey
    );

    return this._formatMessage(signedMessage);
  }

  /**
   * Check if the signature is ready
   * @returns {boolean}
   */
  isSignatureReady() {
    return this.#round === 5;
  }

  /**
   * Get the signature object once the rounds are complete
   * @returns {{ r: string, s: string, v: number, pubKey: string }} Signature object
   */
  getSignature() {
    assert(this.isSignatureReady(), 'Signature not ready');

    if (this.#signature) {
      return this.#signature;
    }

    const convertedSignature = DklsUtils.verifyAndConvertDklsSignature(
      this.#messageHash,
      this.#dsg.signature,
      this.#keychain.commonKeyChain.toString('hex'),
      this.#derivationPath,
      null,
      false
    );

    const [recoveryParam, R, S, pubKey] = convertedSignature.split(':');
    const signature = {
      r: '0x' + R,
      s: '0x' + S,
      v: parseInt(recoveryParam),
      pubKey
    };

    this.#signature = signature;
    return this.#signature;
  }
};
