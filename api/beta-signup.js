const KEYGEN_ACCOUNT_ID = process.env.KEYGEN_ACCOUNT_ID;
const KEYGEN_ADMIN_TOKEN = process.env.KEYGEN_ADMIN_TOKEN;
const KEYGEN_POLICY_ID = process.env.KEYGEN_POLICY_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, organization, role } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  try {
    const licenseRes = await fetch(
      `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KEYGEN_ADMIN_TOKEN}`,
          'Content-Type': 'application/vnd.api+json',
          Accept: 'application/vnd.api+json',
        },
        body: JSON.stringify({
          data: {
            type: 'licenses',
            attributes: {
              name: `Beta - ${name}`,
              metadata: { email, organization: organization || '', role: role || '' },
            },
            relationships: {
              policy: {
                data: { type: 'policies', id: KEYGEN_POLICY_ID },
              },
            },
          },
        }),
      }
    );

    if (!licenseRes.ok) {
      const err = await licenseRes.json();
      console.error('Keygen error:', JSON.stringify(err));
      return res.status(502).json({ error: 'Failed to create license' });
    }

    const licenseData = await licenseRes.json();
    const licenseKey = licenseData.data.attributes.key;

    // TODO: Send email with licenseKey and download links via Resend/SendGrid.
    // For now, log it and return success.
    console.log(`Beta license created for ${email}: ${licenseKey}`);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Beta signup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
