// supabase/functions/_shared/messenger.ts
// Envoi de messages Facebook Messenger depuis Edge Functions

const FB_API = 'https://graph.facebook.com/v21.0/me/messages';

interface MessagePayload {
  text?: string;
  attachment?: object;
  quick_replies?: Array<{ title: string; payload?: string }>;
  buttons?: Array<{ type: string; title: string; url?: string; payload?: string }>;
}

export async function sendMessage(
  senderId: string,
  payload: MessagePayload,
  pageAccessToken: string
): Promise<void> {
  const params = `?access_token=${pageAccessToken}`;

  // Typing on
  await fetch(FB_API + params, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderId }, sender_action: 'typing_on' })
  });

  // Construire le message
  const messageObj: Record<string, unknown> = {};

  if (payload.text && !payload.buttons?.length) {
    messageObj.text = payload.text;
  }

  if (payload.buttons?.length) {
    messageObj.attachment = {
      type: 'template',
      payload: {
        template_type: 'button',
        text: payload.text || 'Choisissez une option :',
        buttons: payload.buttons.map(b => ({
          type: b.type || 'postback',
          title: b.title,
          ...(b.url ? { url: b.url } : {}),
          ...(b.payload ? { payload: b.payload } : {})
        }))
      }
    };
  } else if (payload.attachment) {
    messageObj.attachment = payload.attachment;
  }

  if (payload.quick_replies?.length) {
    messageObj.quick_replies = payload.quick_replies.map(r => ({
      content_type: 'text',
      title: r.title,
      payload: r.payload || r.title
    }));
  }

  const resp = await fetch(FB_API + params, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderId }, message: messageObj })
  });

  if (!resp.ok) {
    const err = await resp.json();
    console.error('❌ Messenger API Error:', JSON.stringify(err));
  }

  // Typing off
  await fetch(FB_API + params, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderId }, sender_action: 'typing_off' })
  });
}
