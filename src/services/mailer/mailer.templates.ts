import { APP_PRODUCT_NAME } from '../../config/constants.js';
import type { NoticeEmailContent, TransactionalEmailContent } from './mailer.types.js';

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return entities[char] ?? char;
  });

const buildEmailLayoutHtml = ({
  bodyHtml,
  footerText,
  title,
}: {
  bodyHtml: string;
  footerText: string;
  title: string;
}): string => {
  const safeTitle = escapeHtml(title);
  const safeFooterHtml = escapeHtml(footerText).replace(/\n/g, '<br/>');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    </head>
    <body style="margin:0;padding:0;background:#fefefe;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fefefe;padding:32px 0;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
            <tr>
              <td style="background:#111111;padding:20px 32px;border-radius:12px 12px 0 0;">
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.5px;">${APP_PRODUCT_NAME}</span>
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;padding:40px 32px 36px;text-align:center;">
                <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111111;">${safeTitle}</h1>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="background:#111111;padding:16px 32px;border-radius:0 0 12px 12px;text-align:center;">
                <p style="margin:0;font-size:12px;color:#bbbbbb;">
                  ${safeFooterHtml}
                </p>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;
};

export function buildTransactionalEmailHtml({
  title,
  intro,
  actionCode,
  expiryLabel,
  footerText,
}: TransactionalEmailContent): string {
  const safeIntro = escapeHtml(intro);
  const safeActionCode = escapeHtml(actionCode);
  const safeExpiryLabel = escapeHtml(expiryLabel);

  return buildEmailLayoutHtml({
    title,
    footerText,
    bodyHtml: `
                <p style="margin:0 0 28px;font-size:15px;color:#555555;line-height:1.6;">
                  ${safeIntro}<br/>
                  <span style="font-size:13px;color:#999999;">${safeExpiryLabel}</span>
                </p>
                <div style="display:inline-block;background:#f5f5f5;color:#111111;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:28px;font-weight:700;padding:14px 24px;border-radius:8px;border:1px solid #dddddd;">${safeActionCode}</div>
    `,
  });
}

export function buildTransactionalEmailText({
  title,
  actionCode,
  expiryLabel,
  footerText,
}: Pick<TransactionalEmailContent, 'title' | 'actionCode' | 'expiryLabel' | 'footerText'>): string {
  return `${title}\nCode: ${actionCode}\n\n${expiryLabel}\n\n${footerText}`;
}

export function buildNoticeEmailHtml({
  title,
  intro,
  detailsLabel,
  details,
  footerText,
}: NoticeEmailContent): string {
  const safeIntro = escapeHtml(intro);
  const safeDetailsLabel = escapeHtml(detailsLabel);
  const safeDetails = escapeHtml(details);

  return buildEmailLayoutHtml({
    title,
    footerText,
    bodyHtml: `
                <p style="margin:0 0 24px;font-size:15px;color:#555555;line-height:1.6;">
                  ${safeIntro}
                </p>
                <div style="background:#f5f5f5;color:#111111;text-align:left;font-size:14px;line-height:1.6;padding:18px 20px;border-radius:8px;border:1px solid #dddddd;">
                  <p style="margin:0 0 8px;font-weight:700;color:#111111;">${safeDetailsLabel}</p>
                  <p style="margin:0;white-space:pre-wrap;color:#333333;">${safeDetails}</p>
                </div>
    `,
  });
}

export function buildNoticeEmailText({
  title,
  intro,
  detailsLabel,
  details,
  footerText,
}: NoticeEmailContent): string {
  return `${title}\n\n${intro}\n\n${detailsLabel}:\n${details}\n\n${footerText}`;
}
