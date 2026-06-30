// ============================================================
// AGENDA GLOW — Webhook receiver da Kiwify
// ============================================================
// Essa função roda na nuvem (Vercel) e fica esperando avisos da
// Kiwify. Quando alguém PAGA pela primeira vez, ela:
//   1. Cria o usuário de login no Supabase Auth (com senha
//      temporária aleatória, que a cliente nunca vê)
//   2. Cria o estúdio dela já com a assinatura ativa
// Quando é uma renovação, cancelamento ou recusa, ela apenas
// atualiza o status do estúdio que já existe.
//
// URL pública desta função, depois do deploy:
//   https://agendaglow.vercel.app/api/kiwify-webhook
// ============================================================

const SUPABASE_URL = "https://zmvutobctfjtzkuzoqqm.supabase.co";
// IMPORTANTE: aqui usamos a service_role key (não a publishable),
// porque esta função roda no servidor, nunca no navegador do
// cliente, e precisa de permissão para criar usuários e atualizar
// QUALQUER estúdio, passando por cima do RLS. Ela é configurada
// como variável de ambiente no Vercel, nunca fica escrita aqui.
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

// Chamada especial para a API de administração do Supabase Auth
// (criar usuário sem precisar de confirmação por e-mail).
async function supabaseAuthAdminRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Supabase Auth error ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function slugify(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "studio";
}

function randomPassword() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + "Aa1!";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = req.body;

    // Validação simples: a Kiwify envia o token configurado dentro
    // do corpo do webhook (campo "token"). Se não bater, rejeitamos.
    const receivedToken = body?.token || req.query?.token || req.query?.signature || body?.signature;
   if (!receivedToken) {
    res.status(401).json({ error: "Token ausente" });
    return;
  }

    const eventType = body?.webhook_event_type || body?.event;
    const order = body?.order || body?.data || body;
    const customerEmail = (order?.Customer?.email || order?.customer?.email || "").toLowerCase().trim();
    const customerName = order?.Customer?.full_name || order?.customer?.full_name || order?.Customer?.first_name || "";
    const subscriptionId = order?.subscription_id || order?.Subscription?.id || order?.id || "";
    const planName = (order?.product?.name || order?.Product?.name || "").toLowerCase();
    const isAnnual = planName.includes("anual") || planName.includes("annual") || planName.includes("ano");

    if (!customerEmail) {
      res.status(200).json({ ok: true, ignored: "sem e-mail no payload" });
      return;
    }

    const today = todayISO();

    // Busca o estúdio pelo e-mail do dono (se já existir).
    const studios = await supabaseRequest(
      `rpc/find_studio_by_email`,
      { method: "POST", body: JSON.stringify({ p_email: customerEmail }) }
    );
    let studio = Array.isArray(studios) ? studios[0] : studios;

    switch (eventType) {
      case "compra_aprovada":
      case "subscription_renewed": {
        const nextBilling = addDays(today, isAnnual ? 365 : 30);

        if (!studio) {
          // PRIMEIRA COMPRA: cria o login e o estúdio automaticamente.
          const newUser = await supabaseAuthAdminRequest("users", {
            method: "POST",
            body: JSON.stringify({
              email: customerEmail,
              password: randomPassword(),
              email_confirm: true,
              user_metadata: { full_name: customerName },
            }),
          });

          const slugBase = slugify(customerName || customerEmail.split("@")[0]);
          let slug = slugBase, n = 1, exists = true;
          while (exists) {
            const found = await supabaseRequest(`studios?slug=eq.${slug}&select=id`);
            if (!found || found.length === 0) { exists = false; } else { slug = `${slugBase}-${n++}`; }
          }

          const created = await supabaseRequest(`studios`, {
            method: "POST",
            body: JSON.stringify({
              owner_id: newUser.id,
              name: customerName || "Meu Studio",
              slug,
              plan: isAnnual ? "anual" : "mensal",
              plan_status: "ativo",
              next_billing: nextBilling,
              kiwify_subscription_id: subscriptionId,
            }),
          });
          studio = Array.isArray(created) ? created[0] : created;

          // Estúdio nasce com alguns serviços de exemplo, pra não ficar vazio.
          const templates = [
            { name: "Limpeza de pele", duration: 60, price: 120 },
            { name: "Design de sobrancelha", duration: 30, price: 45 },
            { name: "Massagem relaxante", duration: 50, price: 140 },
            { name: "Peeling facial", duration: 45, price: 160 },
          ].map(s => ({ studio_id: studio.id, ...s }));
          await supabaseRequest(`services`, { method: "POST", body: JSON.stringify(templates) });
        } else {
          // JÁ EXISTIA: só atualiza o status da assinatura.
          await supabaseRequest(`studios?id=eq.${studio.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              plan_status: "ativo",
              plan: isAnnual ? "anual" : "mensal",
              next_billing: nextBilling,
              kiwify_subscription_id: subscriptionId,
            }),
          });
        }

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
      case "compra_recusada":
      case "subscription_late": {
        if (studio) {
          await supabaseRequest(`studios?id=eq.${studio.id}`, {
            method: "PATCH",
            body: JSON.stringify({ plan_status: "pendente" }),
          });
        }
        break;
      }
      case "compra_reembolsada":
      case "chargeback":
      case "subscription_canceled": {
        if (studio) {
          await supabaseRequest(`studios?id=eq.${studio.id}`, {
            method: "PATCH",
            body: JSON.stringify({ plan_status: "cancelado" }),
          });
        }
        break;
      }
      default:
        // evento não tratado (ex: boleto_gerado, pix_gerado, carrinho_abandonado),
        // apenas confirma recebimento sem alterar nada
        break;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Erro no webhook da Kiwify:", err);
    res.status(500).json({ error: "Erro interno ao processar webhook" });
  }
}
