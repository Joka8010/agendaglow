// ============================================================
// AGENDA GLOW — Ativação de conta após pagamento na Kiwify
// ============================================================
// Depois que o webhook da Kiwify cria o usuário (com senha
// temporária aleatória) e o estúdio, a cliente acessa a tela
// "Criar minha senha" no site e informa: e-mail usado na compra
// + a senha que ela quer usar a partir de agora.
//
// Esta função verifica que existe um estúdio com aquele e-mail,
// e define a senha definitiva usando a API de administração do
// Supabase (sem precisar enviar nenhum e-mail de confirmação).
// ============================================================

const SUPABASE_URL = "https://zmvutobctfjtzkuzoqqm.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { email, password } = req.body || {};
    const normalizedEmail = (email || "").toLowerCase().trim();

    if (!normalizedEmail || !password || password.length < 6) {
      res.status(400).json({ error: "E-mail e senha (mínimo 6 caracteres) são obrigatórios." });
      return;
    }

    // Confirma que existe um estúdio (pago) com esse e-mail.
    const studios = await supabaseRequest(
      `rpc/find_studio_by_email`,
      { method: "POST", body: JSON.stringify({ p_email: normalizedEmail }) }
    );
    const studio = Array.isArray(studios) ? studios[0] : studios;

    if (!studio) {
      res.status(404).json({ error: "Não encontramos nenhuma assinatura paga com este e-mail. Verifique se digitou o mesmo e-mail usado na compra." });
      return;
    }

    if (studio.plan_status !== "ativo") {
      res.status(403).json({ error: "Sua assinatura ainda não está ativa. Aguarde a confirmação do pagamento ou entre em contato com o suporte." });
      return;
    }

    // Define a senha definitiva para o usuário dono desse estúdio.
    await supabaseAuthAdminRequest(`users/${studio.owner_id}`, {
      method: "PUT",
      body: JSON.stringify({ password }),
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Erro ao ativar conta:", err);
    res.status(500).json({ error: "Erro interno ao ativar sua conta. Tente novamente em instantes." });
  }
}
