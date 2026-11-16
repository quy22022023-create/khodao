/*
 * CẤU HÌNH DỰ ÁN SỔ GHI
 * Giai đoạn kiểm thử giao diện: chạy ở chế độ local-demo bằng IndexedDB.
 * Sau khi duyệt web và tạo schema SQL, mới điền thông tin Supabase tại đây
 * và bật phần đồng bộ cloud trong soghi.js.
 */
window.SOGHI_CONFIG = Object.freeze({
  mode: "local-demo",
  supabaseUrl: "",
  supabaseAnonKey: "",
  tablePrefix: "soghi_"
});
