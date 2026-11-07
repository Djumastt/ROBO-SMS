const { createClient } = require('@supabase/supabase-js');
const express = require('express');

// Conexão com o Supabase
const supabaseUrl = 'https://lvdhbzjksspozeionbyg.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
app.use(express.json());

const TABELAS_FILA_SMS = [
    'fila_sms',
    'fila_sms_1',
    'fila_sms_2',
    'fila_sms_3'
];

let indiceUltimaFilaSMS = 0;

async function obterProximaTabelaFilaSMS() {
    let tabelaEscolhida = TABELAS_FILA_SMS[indiceUltimaFilaSMS];
    indiceUltimaFilaSMS = (indiceUltimaFilaSMS + 1) % TABELAS_FILA_SMS.length;
    return tabelaEscolhida;
}

async function inserirNaFilaSMS(dadosPedido) {
    const tabelaDestino = await obterProximaTabelaFilaSMS();
    const { error } = await supabase.from(tabelaDestino).insert([dadosPedido]);
    if (error) {
        console.log(`❌ [FILA] Erro ao inserir na tabela ${tabelaDestino}:`, error.message);
    } else {
        console.log(`✅ [FILA] Pedido direcionado com sucesso em ordem para: ${tabelaDestino}`);
    }
    return tabelaDestino;
}

// ==========================================
// 1. ROTA DE INGESTÃO (Recebe do MacroDroid)
// ==========================================
app.post('/sms-recebido', async (req, res) => {
    console.log("\n--------------------------------------------------");
    console.log("📥 [TERMINAL] Requisição POST recebida em /sms-recebido!");
    console.log("📦 [TERMINAL] Dados crus recebidos:", req.body);

    try {
        const sender = req.body.sender || req.body.telefone || req.body.from;
        const mensagem = req.body.mensagem || req.body.text || req.body.body;

        if (!sender || !mensagem) {
            console.log("⚠️ [TERMINAL] ERRO: Sender ou mensagem em falta no corpo do pedido!");
            return res.status(400).json({ erro: 'Sender e mensagem obrigatórios' });
        }

        const { error } = await supabase.from('sms_entrada').insert([{
            sender: String(sender),
            receber: String(mensagem), 
            referencia: 'PENDENTE',
            valor: '0',
            status: 'pendente'
        }]);

        if (error) {
            console.log("❌ [TERMINAL] Erro ao guardar SMS bruto no Supabase:", error.message);
            return res.status(500).json({ erro: error.message });
        }

        console.log(`✅ [TERMINAL] SMS bruto de [${sender}] guardado na tabela 'sms_entrada' com sucesso!`);
        return res.json({ status: 'sucesso', mensagem: 'SMS guardado para processamento' });

    } catch (err) {
        console.log("❌ [TERMINAL] Erro crítico na rota /sms-recebido:", err.message);
        return res.status(500).json({ erro: err.message });
    }
});

// ==========================================
// 2. O ROBÔ PROCESSADOR (Background Worker)
// ==========================================
function iniciarRoboProcessamentoSMS() {
    setInterval(async () => {
        try {
            // =========================================================
            // PARTE A: PROCESSAR SMS DE ENTRADA (Comprovativos / Recebimentos)
            // =========================================================
            const { data: pendentes, error } = await supabase
                .from('sms_entrada')
                .select('*')
                .eq('status', 'pendente')
                .limit(3);

            if (!error && pendentes && pendentes.length > 0) {
                for (let item of pendentes) {
                    const texto = String(item.receber || '').trim();
                    const textoLower = texto.toLowerCase();
                    
                    const ehComprovativoEnviado = textoLower.includes("confirmado") || 
                                              textoLower.includes("transacao") || 
                                              textoLower.includes("ref") ||
                                              textoLower.includes("transferiste");

                    const ehRecebimentoDireto = textoLower.includes("recebeu") || textoLower.includes("id trans");

                    if (texto.length < 10 || (!ehComprovativoEnviado && !ehRecebimentoDireto)) {
                        continue;
                    }

                    console.log(`\n⚙️ [ROBÔ] A processar SMS ID ${item.id} (Tipo: ${ehRecebimentoDireto ? 'Recebimento Direto' : 'Comprovativo Enviado'})...`);

                    // -------------------------------------------------------------
                    // CASO A: SMS DE RECEBIMENTO DIRETO
                    // -------------------------------------------------------------
                    if (ehRecebimentoDireto) {
                        let matchRef = texto.match(/(ID Trans|Transacao|Ref)[:\s]+([A-Z0-9.]+)/i);
                        let referencia = matchRef ? matchRef[2].replace(/\.$/, "").trim() : "NAO_ENCONTRADA";
                        
                        let valorConfirmado = 0;
                        const matchValor = texto.match(/(\d+([.,]\d+)?)\s*MT/i);
                        if (matchValor) {
                            valorConfirmado = parseFloat(matchValor[1].replace(',', '.'));
                        }

                        let clientePagador = null;
                        const matchPagador = texto.match(/Recebeu\s+[\d.,]+\s*MT\s+de\s+(8[4567]\d{7})/i);
                        if (matchPagador) {
                            clientePagador = matchPagador[1];
                        } else {
                            const numsGerais = texto.match(/\b(8[4567]\d{7})\b/g) || [];
                            if (numsGerais.length > 0) clientePagador = numsGerais[0];
                        }
                        if (!clientePagador) clientePagador = item.sender;

                        let numeroDestinatario = null;
                        const matchConteudo = texto.match(/conteudo[:\s]+(8[45]\d{7})/i);
                        if (matchConteudo) {
                            numeroDestinatario = matchConteudo[1];
                        }

                        if (!numeroDestinatario) {
                            console.log(`🤫 [RECEBIMENTO] Silencioso: Conteúdo sem número Vodacom válido (84/85). SMS ignorado.`);
                            await supabase.from('sms_entrada').update({ status: 'rejeitado_sem_vodacom', referencia, valor: String(valorConfirmado), receber: 'SEM_NUMERO_VODACOM' }).eq('id', item.id);
                            continue;
                        }

                        if (referencia === "NAO_ENCONTRADA") {
                            continue;
                        }

                        const { data: jaUsado } = await supabase.from('memoria_aguardando').select('*').eq('referencia', referencia).maybeSingle();
                        if (jaUsado) {
                            await supabase.from('sms_entrada').update({ status: 'duplicado', referencia, valor: String(valorConfirmado), receber: 'JA_USADO' }).eq('id', item.id);
                            continue;
                        }

                        const { data: transacaoReal } = await supabase.from('transecoes_pendentes').select('*').eq('referencia', referencia).eq('status', 'pendente').maybeSingle();
                        if (!transacaoReal) {
                            await supabase.from('sms_entrada').update({ status: 'nao_encontrado', referencia, valor: String(valorConfirmado), receber: numeroDestinatario }).eq('id', item.id);
                            continue;
                        }

                        await supabase.from('sms_entrada').update({ status: 'processado', referencia, valor: String(valorConfirmado), receber: numeroDestinatario }).eq('id', item.id);
                        await supabase.from('sms_macro').insert([{ referencia, valor: valorConfirmado, sender: String(clientePagador), receber: numeroDestinatario, status: 'pendente' }]);

                        await supabase.from('memoria_aguardando').insert([{ sender: String(clientePagador), valor: valorConfirmado, referencia, status: 'usado', usado_por: `Recebimento Direto (${clientePagador})`, data_uso: new Date().toISOString() }]);
                        await supabase.from('transecoes_pendentes').update({ status: 'concluido' }).eq('id', transacaoReal.id);

                        const { data: preco } = await supabase.from('tabela_precos').select('megas').eq('valor', valorConfirmado).maybeSingle();
                        const pacoteMegas = preco?.megas || 'N/A';

                        await inserirNaFilaSMS({
                            telefone: numeroDestinatario,
                            pacote: pacoteMegas,
                            status: 'pendente',
                            sender: String(clientePagador),
                            referencia: referencia
                        });

                        const msgSucessoRecebimento = `✅ Recebemos o seu valor de ${valorConfirmado} MT!\n\n📱 O número ${numeroDestinatario} vai receber os seus megas (${pacoteMegas}).\n\n_⏳ A processar a transferência..._`;
                        await supabase.from('sms_saida').insert([{ telefone: String(clientePagador), mensagem: msgSucessoRecebimento, status: 'pendente' }]);

                        console.log(`✨ [RECEBIMENTO] Validado com sucesso! Destino Vodacom: ${numeroDestinatario} | Pagador: ${clientePagador}`);
                        continue;
                    }

                    // -------------------------------------------------------------
                    // CASO B: COMPROVATIVO ENVIADO PELO CLIENTE
                    // -------------------------------------------------------------
                    let sender = item.sender;
                    let matchRef = texto.match(/(Confirmado|ID da transacao|Transacao|Ref)[:\s]+([A-Z0-9.]+)/i);
                    if (!matchRef) {
                        matchRef = texto.match(/Confirmado\s+([A-Z0-9]+)/i);
                    }
                    let referencia = matchRef ? matchRef[2] || matchRef[1] : "NAO_ENCONTRADA";
                    referencia = referencia.replace(/\.$/, "").trim();

                    let valorConfirmado = 0;
                    const matchValor = texto.match(/(\d+([.,]\d+)?)\s*MT/i);
                    if (matchValor) {
                        valorConfirmado = parseFloat(matchValor[1].replace(',', '.'));
                    }

                    if (referencia === "NAO_ENCONTRADA") {
                        await supabase.from('sms_entrada').update({ status: 'rejeitado', referencia, valor: String(valorConfirmado), receber: 'NAO_ENCONTRADA' }).eq('id', item.id);
                        await supabase.from('sms_saida').insert([{ telefone: String(sender), mensagem: `❌ Formato de comprovativo não reconhecido ou inválido.`, status: 'pendente' }]);
                        continue;
                    }

                    const { data: jaUsado } = await supabase.from('memoria_aguardando').select('*').eq('referencia', referencia).maybeSingle();
                    if (jaUsado) {
                        await supabase.from('sms_entrada').update({ status: 'duplicado', referencia, valor: String(valorConfirmado), receber: 'JA_USADO' }).eq('id', item.id);
                        await supabase.from('sms_saida').insert([{ telefone: String(sender), mensagem: `❌ O teu comprovativo já foi usado anteriormente!`, status: 'pendente' }]);
                        continue;
                    }

                    let numeroVodacom = null;
                    const linhas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    if (linhas.length > 1) {
                        let ultimaLinha = linhas[linhas.length - 1].replace(/\D/g, '');
                        if ((ultimaLinha.startsWith('84') || ultimaLinha.startsWith('85')) && ultimaLinha.length === 9) {
                            numeroVodacom = ultimaLinha;
                        }
                    }

                    if (!numeroVodacom) {
                        await supabase.from('sms_entrada').update({ status: 'rejeitado_sem_numero', referencia, valor: String(valorConfirmado), receber: 'NUMERO_FALTA' }).eq('id', item.id);
                        const msgExemplo = `❌ O comprovativo deve ser enviado com o número em baixo.\n\nExemplo de envio correto:\n\nID da transacao PP261101.2357.c37984. Transferiste 15.00MT para conta 871828554, nome: Sergio Juliao Antonio as 23:57:26 de 01/11/2026. Taxa: 0.00MT. O saldo da tua conta e 548.00MT. Conteudo: 1. Em caso de duvida, liga 100. Obrigado!\n84*******`;
                        await supabase.from('sms_saida').insert([{ telefone: String(sender), mensagem: msgExemplo, status: 'pendente' }]);
                        continue;
                    }

                    const { data: transacaoReal } = await supabase.from('transecoes_pendentes').select('*').eq('referencia', referencia).eq('status', 'pendente').maybeSingle();
                    if (!transacaoReal) {
                        console.log(`🤫 [COMPROVATIVO] Silencioso: Referência não pendente em transecoes_pendentes (${referencia}). Ignorado.`);
                        await supabase.from('sms_entrada').update({ status: 'nao_encontrado', referencia, valor: String(valorConfirmado), receber: numeroVodacom }).eq('id', item.id);
                        continue;
                    }

                    await supabase.from('sms_entrada').update({ status: 'processado', referencia, valor: String(valorConfirmado), receber: numeroVodacom }).eq('id', item.id);
                    await supabase.from('sms_macro').insert([{ referencia, valor: valorConfirmado, sender: String(sender), receber: numeroVodacom, status: 'pendente' }]);
                    
                    await supabase.from('transecoes_pendentes').update({ status: 'concluido' }).eq('id', transacaoReal.id);
                    await supabase.from('memoria_aguardando').insert([{ sender: String(sender), valor: valorConfirmado, referencia, status: 'usado', usado_por: `SMS (${sender})`, data_uso: new Date().toISOString() }]);

                    const { data: preco } = await supabase.from('tabela_precos').select('megas').eq('valor', valorConfirmado).maybeSingle();
                    const pacoteMegas = preco?.megas || 'N/A';

                    await inserirNaFilaSMS({
                        telefone: numeroVodacom,
                        pacote: pacoteMegas,
                        status: 'pendente',
                        sender: String(sender),
                        referencia: referencia
                    });

                    const msgResposta = `✅ Pedido Recebido!\n\n💰 Referência: ${referencia}\n📊 Megas: ${pacoteMegas}\n📱 Número: ${numeroVodacom}\n\n_⏳Processando... Aguarde enquanto o Sistema executa a transferência_`;
                    await supabase.from('sms_saida').insert([{ telefone: String(sender), mensagem: msgResposta, status: 'pendente' }]);

                    console.log(`✅ [ROBÔ] Comprovativo processado e enfileirado com sucesso!`);
                }
            }

            // =========================================================
            // PARTE B: VERIFICAR 'sms_concluidos' (Gravado pelo Macrodroid)
            // =========================================================
            const { data: concluidosPeloMacro, error: errConcluidos } = await supabase
                .from('sms_concluidos')
                .select('*')
                .limit(3);

            if (!errConcluidos && concluidosPeloMacro && concluidosPeloMacro.length > 0) {
                for (let itemConcluido of concluidosPeloMacro) {
                    const referencia = String(itemConcluido.referencia || '').trim();
                    const clienteSender = itemConcluido.sender;
                    const telefoneDestino = itemConcluido.receber || itemConcluido.telefone;
                    const valorTransacao = itemConcluido.valor;

                    if (!referencia || referencia === 'undefined') {
                        await supabase.from('sms_concluidos').delete().eq('id', itemConcluido.id);
                        continue;
                    }

                    let encontradoNaFila = false;
                    let tabelaEncontrada = null;
                    let registoFila = null;

                    for (let tabelaFila of TABELAS_FILA_SMS) {
                        const { data: filaData } = await supabase
                            .from(tabelaFila)
                            .select('*')
                            .eq('referencia', referencia)
                            .maybeSingle();

                        if (filaData) {
                            encontradoNaFila = true;
                            tabelaEncontrada = tabelaFila;
                            registoFila = filaData;
                            break;
                        }
                    }

                    if (encontradoNaFila && registoFila) {
                        const telefoneFila = registoFila.telefone || registoFila.receber;
                        
                        await supabase
                            .from(tabelaEncontrada)
                            .update({ status: 'concluido' })
                            .eq('id', registoFila.id);

                        console.log(`✅ [FILA] Registo ${referencia} encontrado em '${tabelaEncontrada}' e marcado como 'concluido'.`);

                        const { data: preco } = await supabase.from('tabela_precos').select('megas').eq('valor', valorTransacao).maybeSingle();
                        const pacoteMegas = preco?.megas || registoFila.pacote || 'N/A';
                        const dataHoraAtual = new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' });

                        const msgConcluidoFinal = `✅ Transação Concluída Com Sucesso\n\n💰 *Referência:* ${referencia}\n📱 Telefone: ${telefoneDestino}\n📊 Pacote: ${pacoteMegas}\n⏰ Data/Hora: ${dataHoraAtual}\n📱 Finalizado: Dispositivo 1\n\n_Transferencia Processada Automáticamente Pelo Sistema_`;

                        await supabase.from('sms_saida').insert([{
                            telefone: String(clienteSender),
                            mensagem: msgConcluidoFinal,
                            status: 'pendente'
                        }]);

                        await supabase.from('sms_concluidos').delete().eq('id', itemConcluido.id);
                        console.log(`🧹 [SMS_CONCLUIDOS] Registo ${referencia} limpo da tabela sms_concluidos com sucesso!`);

                    } else {
                        console.log(`⚠️ [LIMPEZA] Referência '${referencia}' em sms_concluidos não encontrada nas filas. A limpar registo órfão.`);
                        await supabase.from('sms_concluidos').delete().eq('id', itemConcluido.id);
                    }
                }
            }

        } catch (err) {
            console.log("❌ [ROBÔ] Erro no ciclo de processamento:", err.message);
        }
    }, 4000);
}

// ==========================================
// ROTA: CONSULTAR SMS PENDENTES DE SAÍDA
// ==========================================
app.get('/sms-saida', async (req, res) => {
    try {
        const { data: pendentes, error } = await supabase
            .from('sms_saida')
            .select('*')
            .eq('status', 'pendente')
            .limit(5);

        if (error) return res.status(500).json({ erro: error.message });

        if (pendentes && pendentes.length > 0) {
            const ids = pendentes.map(p => p.id);
            await supabase.from('sms_saida').update({ status: 'enviado' }).in('id', ids);
            console.log(`📤 [TERMINAL] Macrodroid consultou a saída. Enviados ${ids.length} registos.`);
        }

        return res.json(pendentes || []);
    } catch (err) {
        return res.status(500).json({ erro: err.message });
    }
});

// Configuração obrigatória de porta dinâmica e host para o Railway (0.0.0.0 + process.env.PORT)
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🌐 Servidor SMS rodando na porta ${PORTA} ✅`);
    console.log(`🤖 Robô processador em segundo plano ativado!`);
    console.log(`==================================================\n`);
    iniciarRoboProcessamentoSMS();
});

