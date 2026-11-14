(() => {
  const form = document.getElementById('login-form');
  const input = document.getElementById('password');
  const msg = document.getElementById('login-msg');
  const btn = document.getElementById('login-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) { msg.textContent = 'Please enter the password.'; return; }
    btn.disabled = true;
    msg.textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { location.reload(); return; }
      if (res.status === 403) { location.reload(); return; } // now blocked: the server shows the blocked page
      msg.textContent = data.error || 'Something went wrong.';
      input.value = '';
      input.focus();
    } catch {
      msg.textContent = 'Cannot reach the server.';
    } finally {
      btn.disabled = false;
    }
  });
})();
