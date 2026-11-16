/* Chạy soghi-supabase.sql trước, sau đó điền 2 giá trị bên dưới.
 * mode: "auto" bật cloud khi có URL/key; để trống thì dùng dữ liệu cục bộ.
 * Chỉ dùng publishable/anon key; không dùng service_role hoặc secret key.
 */
window.SOGHI_CONFIG = Object.freeze({
  mode: "auto",
  supabaseUrl: "",
  supabaseAnonKey: "",
  tablePrefix: "soghi_"
});
