module.exports = function autorizar(req, res, next) {
  if (req.usuario.papel === 'admin') return next();
  const clienteId = parseInt(req.params.clienteId, 10);
  if (isNaN(clienteId)) {
    return res.status(400).json({ erro: 'clienteId inválido' });
  }
  if (req.usuario.clienteId !== clienteId) {
    return res.status(403).json({ erro: 'Acesso negado' });
  }
  next();
};
