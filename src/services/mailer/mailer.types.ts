export type MailerConfig = {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
};

export type TransactionalEmailContent = {
  title: string;
  intro: string;
  actionCode: string;
  expiryLabel: string;
  footerText: string;
};
