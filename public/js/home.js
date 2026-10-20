const nameInput = document.getElementById('name');
const err = document.getElementById('err');
nameInput.value = localStorage.getItem('bl-name') || '';

// Room codes look like abc-defg
const makeCode = () => {
  const l = n => Array.from({ length: n }, () => 'abcdefghjkmnpqrstuvwxyz'[Math.floor(Math.random() * 23)]).join('');
  return `${l(3)}-${l(4)}`;
};

function needName(){
  const n = nameInput.value.trim();
  if (!n){ err.textContent = 'Enter your name first so friends know who you are.'; nameInput.focus(); return null; }
  localStorage.setItem('bl-name', n);
  return n;
}

document.getElementById('create').addEventListener('click', () => {
  if (!needName()) return;
  location.href = `/room/${makeCode()}`;
});

document.getElementById('joinForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!needName()) return;
  const match = document.getElementById('code').value.toLowerCase().match(/[a-z]{3}-[a-z]{4}/);
  if (!match){ err.textContent = 'That code should look like abc-defg. Paste the code or the full invite link.'; return; }
  location.href = `/room/${match[0]}`;
});
