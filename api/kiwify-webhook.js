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

// Cria o usuário no Supabase Auth. Se o e-mail já existir (erro 422),
// busca o usuário já existente em vez de falhar — isso resolve o caso
// de reenvios de webhook ou tentativas anteriores que já criaram o login,
// mas sem o estúdio ter sido criado junto.
async function getOrCreateAuthUser(email, name) {
  try {
    return await supabaseAuthAdminRequest("users", {
      method: "POST",
      body: JSON.stringify({
        email,
        password: randomPassword(),
        email_confirm: true,
        user_metadata: { full_name: name },
      }),
    });
  } catch (err) {
    const alreadyExists = /already been registered|422|already exists/i.test(err.message);
    if (!alreadyExists) throw err;

    // Usuário já existe: procura ele na lista de usuários do Auth.
    let page = 1;
    const perPage = 200;
    while (page <= 25) { // limite de segurança: até 5000 usuários
      const list = await supabaseAuthAdminRequest(`users?page=${page}&per_page=${perPage}`, {
        method: "GET",
      });
      const users = list?.users || [];
      const found = users.find(u => (u.email || "").toLowerCase() === email.toLowerCase());
      if (found) return found;
      if (users.length < perPage) break; // acabou a lista
      page++;
    }
    throw new Error(`Usuário com e-mail ${email} não encontrado no Auth mesmo após erro de duplicidade.`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = req.body;

    // Validação de segurança: a Kiwify manda o token configurado no
    // painel (query string ?token=... ou dentro do corpo). Comparamos
    // com o valor salvo em KIWIFY_WEBHOOK_TOKEN — se não bater, ou se a
    // variável de ambiente não estiver configurada, rejeitamos.
    const receivedToken = body?.token || req.query?.token || req.query?.signature || body?.signature;
    if (!KIWIFY_WEBHOOK_TOKEN) {
      console.error("KIWIFY_WEBHOOK_TOKEN não está configurado nas variáveis de ambiente.");
      res.status(500).json({ error: "Configuração ausente no servidor" });
      return;
    }
    if (!receivedToken || receivedToken !== KIWIFY_WEBHOOK_TOKEN) {
      res.status(401).json({ error: "Token inválido" });
      return;
    }

   const order = body?.order || body?.data || body;

    // A Kiwify manda o nome do evento (em inglês) dentro de "order",
    // não na raiz do JSON — e usa nomes diferentes dos gatilhos do painel.
    const rawEventType = order?.webhook_event_type || body?.webhook_event_type || body?.event || "";
    const orderStatus = (order?.order_status || "").toLowerCase();

    const EVENT_MAP = {
      order_approved: "compra_aprovada",
      order_paid: "compra_aprovada",
      subscription_renewed: "subscription_renewed",
      order_refused: "compra_recusada",
      subscription_late: "subscription_late",
      order_refunded: "compra_reembolsada",
      refunded: "compra_reembolsada",
      chargeback: "chargeback",
      subscription_canceled: "subscription_canceled",
      subscription_cancelled: "subscription_canceled",
      billet_created: "boleto_gerado",
      pix_created: "pix_gerado",
      cart_abandoned: "carrinho_abandonado",
    };

    let eventType = EVENT_MAP[rawEventType] || rawEventType;

    // Rede de segurança: se algum evento novo/desconhecido chegar mas o
    // status já for "paid", tratamos como compra aprovada mesmo assim.
    if (eventType !== "compra_aprovada" && orderStatus === "paid") {
      eventType = "compra_aprovada";
    }

    const customerEmail = (order?.Customer?.email || order?.customer?.email || "").toLowerCase().trim();
    const customerName = order?.Customer?.full_name || order?.customer?.full_name || order?.Customer?.first_name || "";
    const subscriptionId = order?.subscription_id || order?.Subscription?.id || order?.id || "";

    // O plano vem em order.Subscription.plan, não em order.product/order.Product
    const planName = (order?.Subscription?.plan?.name || order?.Product?.product_name || "").toLowerCase();
    const planFrequency = (order?.Subscription?.plan?.frequency || "").toLowerCase();
    const isAnnual = planFrequency === "yearly" || planFrequency === "annual" || planName.includes("anual") || planName.includes("ano");

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
          // PRIMEIRA COMPRA: cria o login (ou reaproveita se já existir)
          // e o estúdio automaticamente.
          const newUser = await getOrCreateAuthUser(customerEmail, customerName);

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

        // A coluna "method" só aceita: pix, cartao, boleto, gratuito.
        // Mapeamos o método de pagamento real que a Kiwify manda.
        const rawPaymentMethod = (
          order?.payment_method ||
          order?.Payment?.method ||
          order?.payment_type ||
          ""
        ).toLowerCase();
        const METHOD_MAP = {
          credit_card: "cartao",
          card: "cartao",
          pix: "pix",
          billet: "boleto",
          boleto: "boleto",
          free_price: "gratuito",
        };
        const paymentMethod = METHOD_MAP[rawPaymentMethod] || "cartao";

        await supabaseRequest(`payments`, {
          method: "POST",
          body: JSON.stringify({
            studio_id: studio.id,
            label: `Assinatura Agenda Glow — Plano ${isAnnual ? "Anual" : "Mensal"} (Kiwify)`,
            // O valor real da venda vem em Commissions.product_base_price,
            // em CENTAVOS. Dividimos por 100 aqui pq assumimos que sua
            // coluna "amount" guarda em REAIS (ex: 19.90).
            // ⚠️ Se sua coluna guarda em CENTAVOS, remova o "/ 100" abaixo.
            amount: (order?.Commissions?.product_base_price ?? 0) / 100,
            date: today,
            method: paymentMethod,
            status: "pago",
            // A tabela "payments" foi criada pensando na InfinitePay, então
            // não tem colunas "source"/"external_id". Reaproveitamos o
            // campo infinitepay_order_nsu só para guardar o ID da
            // assinatura da Kiwify e manter rastreabilidade.
            infinitepay_order_nsu: subscriptionId,
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
            // A coluna plan_status só aceita: ativo, pendente, atrasado, cancelado
            // (confirmado via studios_plan_status_check no banco).
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
