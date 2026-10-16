import { LoginThrottle } from "./login-throttle";

/**
 * The three budgets a password sign-in draws on, so each closes a way around the others.
 *
 *  - **Address and username** — the precise one: five free failures, then a doubling delay.
 *  - **Address alone** — failures under any username count, so a guesser cannot shed its
 *    delay by failing under throwaway usernames until the real key is evicted from the
 *    bounded table. It also allows twenty free failures, since people share addresses.
 *  - **Account alone** — failures from any address count, so guesses spread across many
 *    addresses still meet a limit. Fifty free failures: high enough that a person's typos
 *    never reach it, low enough that a distributed guesser does quickly.
 *
 * The address and account budgets are *reserved* for the length of a password check, not
 * merely consulted. Verification is deliberately slow, and a check made before it with the
 * failure recorded after lets everything sent at once through: a burst from one address, or
 * from a thousand addresses at one account, would be verified in full before the first
 * failure landed. Reserved, each address and each account has one guess in flight at a time.
 *
 * The account budget gives anyone who knows a username a way to slow its owner's sign-in —
 * by failing fifty times, after which each attempt can be made to wait up to 30 s. Never a
 * lockout. That is the price of a limit distributed guessing cannot spread around.
 */

/** Which keys an attempt reserved, to be settled with fail/succeed and released with end. */
export interface SignInTicket {
  readonly userKey: string;
  readonly addressKey: string;
  readonly accountKey: string;
}

export type SignInStart = { ticket: SignInTicket } | { waitMs: number };

export class SignInLimiter {
  private readonly perAddressUser: LoginThrottle;
  private readonly perAddress: LoginThrottle;
  private readonly perAccount: LoginThrottle;

  constructor(options: { now?: () => number } = {}) {
    this.perAddressUser = new LoginThrottle({ now: options.now });
    this.perAddress     = new LoginThrottle({ now: options.now, freeFailures: 20 });
    this.perAccount     = new LoginThrottle({ now: options.now, freeFailures: 50 });
  }

  /**
   * Start an attempt from `address` at `username`. Either reserves it — the caller must then
   * settle it with {@link fail} or {@link succeed} and always {@link end} it — or says how
   * long to wait. A refused start holds nothing.
   */
  begin(address: string, username: string): SignInStart {
    const account = username.toLowerCase();
    const ticket: SignInTicket = {
      userKey:    `login|${address}|${account}`,
      addressKey: `login-address|${address}`,
      accountKey: `login-account|${account}`,
    };

    const userWait = this.perAddressUser.retryAfterMs(ticket.userKey);
    if (userWait > 0) return { waitMs: userWait };

    const addressWait = this.perAddress.acquire(ticket.addressKey);
    if (addressWait > 0) return { waitMs: addressWait };

    const accountWait = this.perAccount.acquire(ticket.accountKey);
    if (accountWait > 0) {
      // Give back the address reservation, or a refusal here would leave the address unable
      // to sign in to anything until restart.
      this.perAddress.release(ticket.addressKey);
      return { waitMs: accountWait };
    }
    return { ticket };
  }

  /** A wrong password, or an unknown username: counts against all three budgets. */
  fail(ticket: SignInTicket): void {
    this.perAddressUser.recordFailure(ticket.userKey);
    this.perAddress.recordFailure(ticket.addressKey);
    this.perAccount.recordFailure(ticket.accountKey);
  }

  /** A correct password clears all three, so normal use never carries a penalty. */
  succeed(ticket: SignInTicket): void {
    this.perAddressUser.recordSuccess(ticket.userKey);
    this.perAddress.recordSuccess(ticket.addressKey);
    this.perAccount.recordSuccess(ticket.accountKey);
  }

  /** Release the reservations {@link begin} took, however the attempt ended. */
  end(ticket: SignInTicket): void {
    this.perAddress.release(ticket.addressKey);
    this.perAccount.release(ticket.accountKey);
  }
}
