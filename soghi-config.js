/* Cấu hình hiện tại: lưu IndexedDB, chưa triển khai kết nối Supabase.
 * Chỉ bổ sung cloud sau khi kiểm tra schema và duyệt phương án đồng bộ.
 * Không đặt service_role key trong mã trình duyệt.
 */
window.SOGHI_CONFIG = Object.freeze({
  mode: "local-demo",
  supabaseUrl: "",
  supabaseAnonKey: "",
  tablePrefix: "soghi_"
});
