// Email notifications are prepared but OFF by default (EMAIL_ENABLED=false).
// To enable: `npm i nodemailer` is already a dependency; set EMAIL_ENABLED=true and the SMTP_* vars.
export async function sendNotification(subject, text) {
  if (process.env.EMAIL_ENABLED !== "true") return false;
  try {
    const { default: nodemailer } = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: process.env.EMAIL_TO,
      subject,
      text,
    });
    return true;
  } catch (e) {
    console.error("email failed:", e.message);
    return false;
  }
}
