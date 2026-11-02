defmodule MyAppWeb.AdminPlug do
  def init(opts), do: opts
  def call(conn, _opts), do: Plug.Conn.send_resp(conn, 200, "admin")
end

defmodule MyAppWeb.AdminRouter do
  use Phoenix.Router, helpers: false

  get "/health", MyAppWeb.AdminPlug, []
end

defmodule MyAppWeb.Router do
  use Phoenix.Router, helpers: false

  forward "/admin", MyAppWeb.AdminRouter
end
