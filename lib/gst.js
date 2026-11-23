// Carregamento sob demanda do GStreamer (nada é inicializado ao importar).

let _Gst = null;

/** @returns {Promise<object>} o módulo Gst já inicializado */
export async function getGst() {
    if (!_Gst) {
        _Gst = (await import('gi://Gst?version=1.0')).default;
        if (!_Gst.is_initialized())
            _Gst.init(null);
    }
    return _Gst;
}
