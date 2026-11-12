defmodule MyAppWeb.DashboardPlug do
  def init(opts), do: opts
  def call(conn, _opts), do: Plug.Conn.send_resp(conn, 200, "dashboard")
end

defmodule MyAppWeb.Router do
  use Phoenix.Router, helpers: false

  scope "/", host: "admin.example.test" do
    get "/dashboard", MyAppWeb.DashboardPlug, []
  end
end
