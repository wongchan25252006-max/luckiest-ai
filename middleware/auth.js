function requireAuth(req, res, next) {
  if (!req.session.userId) {
    if (req.accepts('html')) return res.redirect('/login.html');
    return res.status(401).json({ error: 'auth required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    if (req.accepts('html')) return res.redirect('/login.html');
    return res.status(403).json({ error: 'admin only' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
