// Tabela de ferramentas do editor e da anotação ao vivo.
// `key` = atalho de teclado (sem modificadores); `needsImage` = precisa da
// imagem congelada (não disponível na anotação ao vivo).

export const TOOLS = [
    {id: 'select', name: 'Selecionar/mover', key: 's', icon: 'tool-select'},
    {id: 'pencil', name: 'Lápis', key: 'p', icon: 'tool-pencil'},
    {id: 'line', name: 'Linha', key: 'l', icon: 'tool-line'},
    {id: 'arrow', name: 'Seta', key: 'a', icon: 'tool-arrow'},
    {id: 'rect', name: 'Retângulo', key: 'r', icon: 'tool-rect'},
    {id: 'rectfill', name: 'Retângulo preenchido', key: 'f', icon: 'tool-rectfill'},
    {id: 'ellipse', name: 'Elipse', key: 'e', icon: 'tool-ellipse'},
    {id: 'marker', name: 'Marca-texto', key: 'm', icon: 'tool-marker'},
    {id: 'text', name: 'Texto', key: 't', icon: 'tool-text'},
    {id: 'counter', name: 'Contador numerado', key: 'n', icon: 'tool-counter'},
    {id: 'pixelate', name: 'Pixelar', key: 'x', icon: 'tool-pixelate', needsImage: true},
    {id: 'blur', name: 'Desfocar', key: 'b', icon: 'tool-blur', needsImage: true},
    {id: 'eraser', name: 'Borracha', key: 'd', icon: 'tool-eraser'},
    {id: 'eyedropper', name: 'Conta-gotas', key: 'i', icon: 'tool-eyedropper', needsImage: true},
];

/** Ferramentas que desenham arrastando de um ponto a outro. */
export const TWO_POINT = new Set(['line', 'arrow', 'rect', 'rectfill', 'ellipse', 'pixelate', 'blur']);

/** Ferramentas de traço livre. */
export const FREEHAND = new Set(['pencil', 'marker']);

export function toolById(id) {
    return TOOLS.find(t => t.id === id) ?? null;
}

export function toolByKey(key) {
    return TOOLS.find(t => t.key === key) ?? null;
}
