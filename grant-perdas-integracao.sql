-- Grants para a importacao de perdas da colheita via AgroControl-api-public.
-- Execute conectado como CSINTEGRACAO (ou usuario DBA).

GRANT SELECT ON csintegracao.cs_agr_perdascolheita TO CONSULTA;
GRANT SELECT ON csintegracao.cs_agr_perdas_itens TO CONSULTA;
GRANT SELECT ON csintegracao.cs_agr_perdasavaliacao TO CONSULTA;

GRANT SELECT, INSERT, UPDATE ON csintegracao.cs_agr_perdascolheita TO CSCLIENTE;
GRANT SELECT, INSERT, UPDATE ON csintegracao.cs_agr_perdas_itens TO CSCLIENTE;
GRANT SELECT, INSERT, UPDATE ON csintegracao.cs_agr_perdasavaliacao TO CSCLIENTE;
