// ============================================================
// AGENDA GLOW — Webhook receiver da Kiwify
// ============================================================
// Essa função roda na nuvem (Vercel) e fica esperando avisos da
// Kiwify. Quando alguém paga, cancela, ou tem o pagamento
// recusado, a Kiwify manda um aviso (POST) pra essa URL, e essa
// função atualiza o status do estúdio certo no Supabase.
//
// URL pública desta função, depois do deploy:
//   https://agendaglow.vercel.app/api/kiwify-webhook
// ============================================================

const SUPABASE_URL = "https://zmvutobctfjtzkuzoqqm.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KIWIFY_WEBHOOK_TOKEN = process.env.KIWIFY_WEBHOOK_TOKEN;

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Prefer": "return=representation",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.json();
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = req.body;

    const receivedToken = body?.token || req.query?.token;
    if (KIWIFY_WEBHOOK_TOKEN && receivedToken !== KIWIFY_WEBHOOK_TOKEN) {
      res.status(401).json({ error: "Token inválido" });
      return;
    }

    const eventType = body?.webhook_event_type || body?.event;
    const order = body?.order || body?.data || body;
    const customerEmail = (order?.Customer?.email || order?.customer?.email || "").toLowerCase().trim();
    const subscriptionId = order?.subscription_id || order?.Subscription?.id || order?.id || "";
    const planName = (order?.product?.name || order?.Product?.name || "").toLowerCase();
    const isAnnual = planName.includes("anual") || planName.includes("annual") || planName.includes("ano");

    if (!customerEmail) {
      res.status(200).json({ ok: true, ignored: "sem e-mail no payload" });
      return;
    }

    const studios = await supabaseRequest(
      `rpc/find_studio_by_email`,
      { method: "POST", body: JSON.stringify({ p_email: customerEmail }) }
    );
    const studio = Array.isArray(studios) ? studios[0] : studios;

    if (!studio) {
      res.status(200).json({ ok: true, ignored: "studio não encontrado para este e-mail" });
      return;
    }

    const today = todayISO();

    switch (eventType) {
      case "order_approved":
      case "compra_aprovada":
      case "subscription_renewed":
      case "assinatura_renovada": {
        const nextBilling = addDays(today, isAnnual ? 365 : 30);
        await supabaseRequest(`studios?id=eq.${studio.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            plan_status: "ativo",
            plan: isAnnual ? "anual" : "mensal",
            next_billing: nextBilling,
            kiwify_subscription_id: subscriptionId,
          }),
        });
        await supabaseRequest(`payments`, {
          method: "POST",
          body: JSON.stringify({
            studio_id: studio.id,
            label: `Assinatura Agenda Glow — Plano ${isAnnual ? "Anual" : "Mensal"} (Kiwify)`,
            amount: order?.product?.price ?? order?.Product?.price ?? 0,
            method: "kiwify",
            status: "pago",
            source: "kiwify",
            external_id: subscriptionId,
          }),
        });
        break;
      }
      case "order_refused":
      case "compra_recusada":
      case "subscription_late":
      case "assinatura_atrasada": {
        await supabaseRequest(`studios?id=eq.${studio.id}`, {
          method: "PATCH",
          body: JSON.stringify({ plan_status: "pendente" }),
        });
        break;
      }
      case "order_refunded":
      case "reembolso":
      case "chargeback":
      case "subscription_canceled":
      case "assinatura_cancelada": {
        await supabaseRequest(`studios?id=eq.${studio.id}`, {
          method: "PATCH",
          body: JSON.stringify({ plan_status: "cancelado" }),
        });
        break;
      }
      default:
        break;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Erro no webhook da Kiwify:", err);
    res.status(500).json({ error: "Erro interno ao processar webhook" });
  }
}
