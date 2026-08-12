module.exports = function verificarPermissao(...slugs) {
  return function (req, res, next) {
    if (req.usuario.papel !== 'funcionario') return next();
    const perms = req.usuario.permissoes || [];
    const temAcesso = slugs.some(s => perms.includes(s));
    if (!temAcesso) return res.status(403).json({ erro: 'Sem permissão para este recurso' });
    next();
  };
};
