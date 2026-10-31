-- Execute conectado como CSCLIENTE. A tabela deve ter INSERT concedido
-- e CSCLIENTE deve ter o privilégio CREATE SEQUENCE.
-- Repetir o script não recria a sequence existente.
DECLARE
  v_qtd NUMBER;
  v_inicio NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_qtd
    FROM user_sequences
   WHERE sequence_name = 'SEQ_APONTAMENTO_APP';
  IF v_qtd = 0 THEN
    SELECT NVL(MAX(id_apont), 0) + 1
      INTO v_inicio
      FROM CSINTEGRACAO.APONTAMENTO_APP;
    EXECUTE IMMEDIATE 'CREATE SEQUENCE CSCLIENTE.SEQ_APONTAMENTO_APP START WITH ' || v_inicio || ' INCREMENT BY 1 NOCACHE';
  END IF;
END;
/