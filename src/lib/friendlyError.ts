/**
 * lib/friendlyError
 * --------------------
 * Every error and rejection reason in this app originates from a
 * technical source — an MT5 retcode, a bridge validation message, a
 * network failure, or a Decision Engine gate name. This module is the
 * single place that translates those into plain language, so a
 * non-developer using the app never has to see "retcode=10018" or
 * "SESSION_EVIDENCE" without knowing what it means.
 *
 * The original technical string is always preserved alongside the
 * translation — never discarded — so a bug report or support request can
 * still include the exact detail a developer would need.
 */

export interface FriendlyError {
  /** Short, plain-language headline. */
  title: string;
  /** One or two sentences explaining what happened and, where possible, what to do. */
  message: string;
  /** Whether trying the same trade again later is reasonable (vs. something that needs fixing first). */
  retryable: boolean;
  /** The original, untranslated text — always available, never shown as the primary message. */
  raw: string;
}

/** MT5 order return codes that are common enough to be worth a specific plain-English explanation. */
const RETCODE_MESSAGES: Record<string, { title: string; message: string; retryable: boolean }> = {
  '10004': {
    title: 'Price moved before the order went through',
    message: 'This is normal in a fast-moving market. The bot will look for the next opportunity.',
    retryable: true,
  },
  '10014': {
    title: 'Trade size not accepted',
    message: "The position size (lot size) isn't valid for this instrument — it may be too small, too large, or not a round enough step.",
    retryable: false,
  },
  '10015': {
    title: 'Price no longer valid',
    message: 'The price changed by the time the order arrived. The bot will look for the next opportunity.',
    retryable: true,
  },
  '10016': {
    title: 'Stop-loss or take-profit too close',
    message: 'Your broker requires the stop-loss and take-profit to be a minimum distance from the current price, and this trade was too tight.',
    retryable: false,
  },
  '10017': {
    title: 'Trading is disabled for this account',
    message: 'Your broker has disabled trading on this account. Contact your broker to confirm your account status.',
    retryable: false,
  },
  '10018': {
    title: 'Market is closed',
    message: "This instrument isn't trading right now (e.g. it's a weekend or outside this market's hours). This isn't an error — try again once the market reopens.",
    retryable: true,
  },
  '10019': {
    title: 'Not enough funds',
    message: "There isn't enough free margin in the account to open this trade.",
    retryable: false,
  },
  '10020': {
    title: 'Price changed',
    message: 'The price moved right as the order was sent. The bot will look for the next opportunity.',
    retryable: true,
  },
  '10021': {
    title: 'Price unavailable',
    message: 'Your broker has no tradable price for this instrument at the moment.',
    retryable: true,
  },
  '10026': {
    title: 'Automated trading disabled by your broker',
    message: 'Your broker has turned off algorithmic/API trading for this account. Contact your broker to enable it.',
    retryable: false,
  },
  '10027': {
    title: 'AutoTrading is turned off',
    message: 'MT5\'s "AutoTrading" toggle is off in your terminal. Turn it on (toolbar button, or Tools \u2192 Options \u2192 Expert Advisors \u2192 "Allow algorithmic trading") and try again.',
    retryable: true,
  },
  '10030': {
    title: "This instrument doesn't support that order type",
    message: 'A technical mismatch with how the order was submitted. This has usually already been fixed — if it keeps happening, it needs a developer to look at it.',
    retryable: false,
  },
  '10031': {
    title: 'Lost connection to your broker',
    message: 'The trade server connection dropped while placing the order. Check your internet connection and that MT5 is still connected.',
    retryable: true,
  },
};

function extractRetcode(raw: string): string | null {
  const match = raw.match(/retcode[=:]?\s*(\d{5})/i);
  return match ? match[1] : null;
}

/** Human-readable names for the Decision Engine's gates — shown when explaining why a candidate was rejected. */
const GATE_LABELS: Record<string, string> = {
  trend_alignment: "the market isn't clearly trending",
  session_evidence: "this trading session doesn't have a strong enough track record yet",
  confidence_threshold: "the setup wasn't confident enough",
  reward_risk: "the potential reward was too small compared to the risk",
  structure_quality: "the chart pattern wasn't clean enough",
  no_news_event: 'a high-impact news event is happening right now — trading paused for safety',
};

/** Same idea, but for the exact gate label strings the Decision Engine already produces (used in rejection reason lists). */
const GATE_LABEL_TEXT: Record<string, string> = {
  'Trend alignment': GATE_LABELS.trend_alignment,
  'Session evidence': GATE_LABELS.session_evidence,
  'Confidence threshold': GATE_LABELS.confidence_threshold,
  'Reward:risk quality': GATE_LABELS.reward_risk,
  'Structure quality': GATE_LABELS.structure_quality,
  'No active news event': GATE_LABELS.no_news_event,
};

/** Translates a single Decision Engine / Risk Manager rejection reason into a plain sentence fragment. */
export function friendlyReason(reason: string): string {
  const cleaned = reason.replace(/^(DecisionEngine|RiskManager|Risk Manager):\s*/i, '');
  return GATE_LABEL_TEXT[cleaned] ?? cleaned;
}

/**
 * Translates a log entry's message for display in an activity feed.
 * ERROR entries get the same broker-error translation used for the
 * execution-failure banner; REJECT entries (from the Decision Engine or
 * Risk Manager, via SystemOrchestrator) get their gate names translated
 * into a plain sentence. Everything else passes through unchanged — INFO
 * and TRADE messages are already written in plain language.
 */
export function friendlyLogMessage(level: string, rawMessage: string): string {
  if (level === 'ERROR') {
    const translated = translateBrokerError(rawMessage);
    return translated.message ? `${translated.title} — ${translated.message}` : translated.title;
  }
  if (level === 'REJECT') {
    const match = rawMessage.match(/^(.*?rejected|.*?vetoed)\s*·\s*(.+)$/i);
    if (match) {
      const reasons = match[2]
        .split(',')
        .map((r) => friendlyReason(r.trim()))
        .filter(Boolean);
      if (reasons.length > 0) {
        return `Skipped a trade because ${reasons.join(', and ')}.`;
      }
    }
  }
  return rawMessage;
}

/** Human label for a candlestick timeframe code, e.g. "15m" -> "15-minute chart". */
export function humanTimeframe(tf: string): string {
  const labels: Record<string, string> = {
    '1m': '1-minute',
    '5m': '5-minute',
    '15m': '15-minute',
    '30m': '30-minute',
    '1h': '1-hour',
    '4h': '4-hour',
    '1d': 'Daily',
  };
  return `${labels[tf] ?? tf} chart`;
}

export function translateBrokerError(raw: string): FriendlyError {
  const retcode = extractRetcode(raw);
  if (retcode && RETCODE_MESSAGES[retcode]) {
    const known = RETCODE_MESSAGES[retcode];
    return { ...known, raw };
  }

  if (/could not reach the mt5 bridge/i.test(raw)) {
    return {
      title: "Can't reach your MT5 connection",
      message: 'Make sure the bridge program is running and MT5 is open and logged in, then try again.',
      retryable: true,
      raw,
    };
  }

  if (/did not respond within/i.test(raw)) {
    return {
      title: 'MT5 is taking too long to respond',
      message: 'It may be frozen or showing a popup that needs attention. Check the MT5 window, then try again.',
      retryable: true,
      raw,
    };
  }

  if (/non-json response/i.test(raw)) {
    return {
      title: 'Unexpected response from your MT5 connection',
      message: 'Something went wrong on the bridge side. Check the bridge program\'s window for details.',
      retryable: true,
      raw,
    };
  }

  if (/stop is .* from price/i.test(raw) || /target is .* from price/i.test(raw)) {
    return {
      title: 'Stop-loss or take-profit too close',
      message: 'Your broker requires a minimum distance between the current price and the stop-loss/take-profit for this trade.',
      retryable: false,
      raw,
    };
  }

  if (/could not select symbol/i.test(raw)) {
    return {
      title: "This instrument isn't available",
      message: "Your broker may use a different name for it (e.g. \"EURUSD.a\" instead of \"EURUSD\"). Check the exact symbol name in MT5's Market Watch.",
      retryable: false,
      raw,
    };
  }

  if (retcode) {
    return {
      title: 'Trade was not placed',
      message: `Your broker rejected this order (code ${retcode}). See the technical details below for the exact reason.`,
      retryable: false,
      raw,
    };
  }

  return {
    title: 'Something went wrong placing this trade',
    message: 'See the technical details below for the exact reason.',
    retryable: false,
    raw,
  };
}
