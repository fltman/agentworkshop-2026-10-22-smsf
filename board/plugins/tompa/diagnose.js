// Boundary decoder (FLUX 05f8eb0a-α): diagnoses every message that crosses the AMF boundary and names the hop and
// the owning team when a peer breaks the agreed contract. Pure functions, no I/O.
// verdict: 'ok' | 'expected' (a negative case the test data asks for) | 'fault' (a peer broke the contract)

const sms = require('./sms');

const OWNER = { nrf: 'smsf-hao', smsf: 'krilju', udm: 'hetoteam', smsc: 'holminator' };

// Negative cases the hetoteam test subscribers are built for (projects/hetoteam/CONTRACT.md).
const EXPECTED = {
  activate: { 'imsi-001010000000003': 'SMS_NOT_ALLOWED', 'imsi-001019999999999': 'USER_UNKNOWN' },
  sendsms: { 'imsi-001010000000005': 'MO_SMS_BARRED' },
};

const ok = () => ({ verdict: 'ok' });
const expected = finding => ({ verdict: 'expected', finding });
const fault = (hop, owner, finding, expect) => ({ verdict: 'fault', hop, owner, finding, expected: expect });

// Which peer behind the SMSF caused an SMSF error, judged from its cause/detail text (krilju's errors carry
// detail "<PEER> answered <status>"). A discovery failure is the SMSF's own query (fault 3: it asked for SMSC, not
// CUSTOM_SMSC). A 400-class data error from the SMSC or UDM means the SMSF built a malformed request (fault 2: it
// forwarded our whole RP-DATA instead of the bare TPDU), so the owner is the SMSF even though the hop is beyond it.
const MALFORMED = /UNEXPECTED_DATA_VALUE|MISSING_AVP|MANDATORY_IE|INVALID_JSON/;
function blame(body) {
  const cause = (body && body.cause) || '';
  const detail = (body && body.detail) || '';
  const t = `${cause} ${detail}`;
  if (/NF_DISCOVERY|DISCOVERY|NRF/i.test(t)) return ['SMSF→NRF', OWNER.smsf];
  const peer = /SMSC/i.test(t) ? 'smsc' : /UDM|UECM|SDM/i.test(t) ? 'udm' : null;
  if (!peer) return ['AMF→SMSF', OWNER.smsf];
  const hop = `SMSF→${peer.toUpperCase()}`;
  const m = /answered (\d+)/.exec(detail);
  if ((m && Number(m[1]) === 400) || MALFORMED.test(cause)) return [hop, OWNER.smsf];
  return [hop, OWNER[peer]];
}

// RP layer check for a payload the SMSF sends to the UE (TS 24.011 7.3: RP-DATA network to MS, MTI 1).
function mtPayload(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex)) {
    return fault('SMSF→AMF', OWNER.smsf, 'smsPayload.hex is not a hex string', 'hex RP-DATA network to MS');
  }
  const first = parseInt(hex.slice(0, 2), 16);
  try {
    sms.parseMt(hex);
    return ok();
  } catch (e) {
    const mti = first & 0x07;
    // An SMS-DELIVER TPDU has TP-MTI 00 in bits 0-1 and a TP-OA length as the second octet, never an RP MTI 1.
    if (mti !== 1 && (first & 0x03) === 0) {
      return fault('SMSF→AMF', OWNER.smsf, 'bare SMS-DELIVER TPDU, RP-DATA header missing', 'RP-DATA network to MS (MTI 1) wrapping the TPDU');
    }
    if (mti !== 1) return fault('SMSF→AMF', OWNER.smsf, `RP MTI ${mti}, not RP-DATA network to MS`, 'RP MTI 1');
    return fault('SMSF→AMF', OWNER.smsf, `RP-DATA does not decode: ${e.message}`, 'valid RP-DATA with SMS-DELIVER');
  }
}

// Incoming N1N2MessageTransfer from the SMSF (TS 29.518 6.1.6.2.27).
function n1n2(body) {
  if (!body || typeof body !== 'object') return fault('SMSF→AMF', OWNER.smsf, 'body is not JSON', 'N1N2MessageTransferReqData');
  const cls = body.n1MessageContainer && body.n1MessageContainer.n1MessageClass;
  if (cls !== 'SMS') return fault('SMSF→AMF', OWNER.smsf, `n1MessageClass is ${cls === undefined ? 'missing' : cls}`, 'n1MessageClass SMS');
  if (!body.smsPayload || !body.smsPayload.hex) return fault('SMSF→AMF', OWNER.smsf, 'smsPayload.hex is missing', 'smsPayload.hex');
  if (!body.smsRecordId) return fault('SMSF→AMF', OWNER.smsf, 'smsRecordId is missing, the RP-ACK cannot be correlated', 'smsRecordId');
  return mtPayload(body.smsPayload.hex);
}

// The RP message the SMSF returns to the UE in the UplinkSMS answer (krilju CONTRACT: RP-ACK MTI 3 on success,
// RP-ERROR MTI 5 in the error body, same RP-MR as our RP-DATA). Optional field: absent is not a fault.
function moAnswer(status, body, sentHex) {
  const hex = body && body.smsPayload && body.smsPayload.hex;
  if (hex === undefined || hex === null) return ok();
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex) || hex.length < 4) {
    return fault('SMSF→AMF', OWNER.smsf, 'UplinkSMS answer smsPayload.hex is not an RP message', 'RP-ACK or RP-ERROR network to MS');
  }
  const want = status === 200 ? { mti: 3, name: 'RP-ACK network to MS (MTI 3)' } : { mti: 5, name: 'RP-ERROR network to MS (MTI 5)' };
  const mti = parseInt(hex.slice(0, 2), 16) & 0x07;
  if (mti !== want.mti) {
    // 0x01 is RP-DATA network to MS as RP, or TP-MTI 01 (SMS-SUBMIT-REPORT) as a bare TPDU; neither belongs here.
    const what = mti === 1 ? 'RP MTI 1: a bare SUBMIT-REPORT TPDU or RP-DATA, RP-ACK/RP-ERROR header missing' : `RP MTI ${mti}`;
    return fault('SMSF→AMF', OWNER.smsf, `UplinkSMS answer is ${what}`, `${want.name} with our RP-MR`);
  }
  if (typeof sentHex === 'string' && sentHex.length >= 4 && hex.slice(2, 4).toUpperCase() !== sentHex.slice(2, 4).toUpperCase()) {
    return fault('SMSF→AMF', OWNER.smsf, `RP-MR ${parseInt(hex.slice(2, 4), 16)} in the answer, we sent ${parseInt(sentHex.slice(2, 4), 16)}`, 'the RP-MR of our RP-DATA');
  }
  return ok();
}

// A response from the SMSF to our Activate / UplinkSMS / Deactivate call.
// opts.expectCause: a cause the caller forced on purpose (e.g. an SMSC ?scenario=), judged as expected.
// opts.sentHex: our UplinkSMS RP-DATA, to check the RP layer and RP-MR of the SMSF's answer.
function smsfResponse(op, supi, status, body, opts = {}) {
  const cause = body && body.cause;
  const want = opts.expectCause || (EXPECTED[op] && EXPECTED[op][supi]);
  if (status === 0) return fault('AMF→SMSF', OWNER.smsf, 'no answer (timeout or connection refused)', 'an HTTP answer within 8 s');
  if (want) {
    if (cause === want) return expected(`${want}, as ${opts.expectCause ? 'the test forced' : 'the test data says'}`);
    return fault(...blame(body), `got ${status} ${cause || ''}`.trim(), `${want} for ${supi}`);
  }
  const good = { activate: [200, 201], sendsms: [200], deactivate: [204] }[op] || [200];
  if (good.includes(status)) return op === 'sendsms' ? moAnswer(status, body, opts.sentHex) : ok();
  const f = fault(...blame(body), `${status} ${cause || ''}${body && body.detail ? `: ${body.detail}` : ''}`.trim(), `${good.join(' or ')}`);
  if (op === 'sendsms' && f.owner !== OWNER.smsf) {
    const rp = moAnswer(status, body, opts.sentHex);
    if (rp.verdict === 'fault') f.also = rp;
  }
  return f;
}

// An NRF discovery result (TS 29.510 6.2.6.2.2). Checks that the profile can actually be called.
function discovery(targetType, status, body) {
  if (status !== 200) return fault('AMF→NRF', OWNER.nrf, `discovery answered ${status}`, '200 SearchResult');
  const list = body && body.nfInstances;
  if (!Array.isArray(list)) return fault('AMF→NRF', OWNER.nrf, 'nfInstances is missing', 'SearchResult.nfInstances array');
  if (!list.length) return fault('AMF→NRF', OWNER.smsf, `no ${targetType} registered`, `a REGISTERED ${targetType} profile`);
  const inst = list[0];
  if (inst.nfType && inst.nfType !== targetType) return fault('AMF→NRF', OWNER.nrf, `asked for ${targetType}, got nfType ${inst.nfType}`, `nfType ${targetType}`);
  const svc = (inst.nfServices || [])[0];
  if (!svc) return fault('AMF→NRF', OWNER.smsf, `${targetType} profile has no nfServices`, 'nfServices with apiRoot or apiPrefix');
  if (!svc.apiRoot && !/^https?:\/\//.test(svc.apiPrefix || '') && !inst.fqdn) {
    return fault('AMF→NRF', OWNER.smsf, `${targetType} profile has no apiRoot, absolute apiPrefix or fqdn`, 'a callable address');
  }
  return ok();
}

// A drafted #build fault report in the agreed format: what was sent, what was expected, what came back.
function report(entry) {
  const d = entry.diag;
  return `@${d.owner} fault on ${d.hop}. Sent/seen: ${entry.method} ${entry.path}. Expected: ${d.expected}. Got: ${d.finding}. (tompa boundary decoder, log id ${entry.id})`;
}

module.exports = { OWNER, EXPECTED, blame, n1n2, mtPayload, moAnswer, smsfResponse, discovery, report };
