// Better Auth needs a way to send verification, password-reset and invitation emails. SES wiring
// (SPEC §3, Amazon SES ap-south-1) is a separate ticket — this interface is the seam so
// createAuth() doesn't have to know or care whether email is wired yet, and tests can inject a
// fake to assert an email "would have been sent" without a real SES dependency.

export interface AuthEmailSender {
  sendVerificationEmail(params: { to: string; url: string }): Promise<void>;
  sendPasswordReset(params: { to: string; url: string }): Promise<void>;
  sendInvitation(params: { to: string; url: string; organizationName: string }): Promise<void>;
}

/** Default until SES is wired: logs at debug level instead of throwing or silently doing nothing. */
export const noopEmailSender: AuthEmailSender = {
  async sendVerificationEmail({ to }) {
    console.debug(`[auth] sendVerificationEmail: SES not yet wired, skipped for ${to}`);
  },
  async sendPasswordReset({ to }) {
    console.debug(`[auth] sendPasswordReset: SES not yet wired, skipped for ${to}`);
  },
  async sendInvitation({ to }) {
    console.debug(`[auth] sendInvitation: SES not yet wired, skipped for ${to}`);
  },
};
