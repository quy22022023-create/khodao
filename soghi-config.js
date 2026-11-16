/* Chạy soghi-supabase.sql trước, sau đó điền 2 giá trị bên dưới.
 * mode: "auto" bật cloud khi có URL/key; để trống thì dùng dữ liệu cục bộ.
 * Chỉ dùng publishable/anon key; không dùng service_role hoặc secret key.
 */
window.SOGHI_CONFIG = Object.freeze({
  mode: "auto",
  supabaseUrl: "https://awxkvzkigfxoidnvmxew.supabase.co",
  supabaseAnonKey: "sb_publishable_gI2Eik7X7NdeZsq27bfmUg_th3s7c-1",
  tablePrefix: "soghi_"
});
