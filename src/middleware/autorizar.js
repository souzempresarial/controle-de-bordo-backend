module.exports = function autorizar(req, res, next) {
  if (req.usuario.papel === 'admin') return next();
  const clienteId = parseInt(req.params.clienteId);
  if (req.usuario.clienteId !== clienteId) {
    return res.status(403).json({ erro: 'Acesso negado' });
  }
  next();
};
