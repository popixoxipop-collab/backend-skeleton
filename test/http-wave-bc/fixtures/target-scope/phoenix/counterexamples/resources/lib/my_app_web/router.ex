defmodule MyAppWeb.ItemController do
  use Phoenix.Controller, formats: [:json]

  def index(conn, _params), do: Plug.Conn.send_resp(conn, 200, "items")
  def show(conn, %{"id" => id}), do: Plug.Conn.send_resp(conn, 200, id)
end

defmodule MyAppWeb.Router do
  use Phoenix.Router, helpers: false

  scope "/api" do
    resources "/items", MyAppWeb.ItemController, only: [:index, :show]
  end
end
