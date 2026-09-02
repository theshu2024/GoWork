import { Modal, Form, Input, Select, InputNumber, Switch, App, Space, Button } from 'antd';
import { useAppStore } from '../store/useAppStore';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const cfg = useAppStore((s) => s.aiConfig);
  const updateCfg = useAppStore((s) => s.updateAIConfig);
  const { message } = App.useApp();
  const [form] = Form.useForm();

  const initialValues = {
    ...cfg,
  };

  async function onOk() {
    try {
      const values = await form.validateFields();
      // Select tags 模式可能返回数组，归一化为字符串
      if (Array.isArray(values.model)) values.model = values.model[0] || '';
      if (Array.isArray(values.ollamaModel)) values.ollamaModel = values.ollamaModel[0] || '';
      updateCfg(values);
      // 同步配置到宿主 LlmManager（供插件 context.llm 使用）
      try {
        await window.electronAPI.llm.saveConfig(values);
      } catch {}
      message.success('配置已保存');
      onClose();
    } catch {}
  }

  return (
    <Modal
      title="⚙️ AI 模型设置"
      open={open}
      onCancel={onClose}
      onOk={onOk}
      okText="保存"
      cancelText="取消"
      width={620}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={initialValues}
        style={{ marginTop: 8 }}
      >
        <Form.Item
          label="提供方（Provider）"
          name="provider"
          rules={[{ required: true }]}
        >
          <Select
            options={[
              { value: 'cloud', label: '☁️ 云端 API（OpenAI 兼容）' },
              { value: 'ollama', label: '🖥️  本地 Ollama 模型' },
            ]}
          />
        </Form.Item>

        <Form.Item noStyle shouldUpdate={(p, n) => p.provider !== n.provider}>
          {({ getFieldValue }) => {
            const provider = getFieldValue('provider');
            if (provider === 'cloud') {
              return (
                <>
                  <Form.Item
                    label="Base URL"
                    name="baseUrl"
                    tooltip="OpenAI 官方 https://api.openai.com/v1；国内代理/其他厂商填写对应地址"
                    rules={[{ required: true, message: '必填' }]}
                  >
                    <Input placeholder="https://api.openai.com/v1" />
                  </Form.Item>
                  <Form.Item
                    label="API Key"
                    name="apiKey"
                    rules={[{ required: true, message: '请填写 API Key' }]}
                    extra={
                      <span style={{ color: '#9ca3af' }}>
                        仅保存在本地 localStorage，不会上传任何服务器。
                      </span>
                    }
                  >
                    <Input.Password placeholder="sk-..." />
                  </Form.Item>
                  <Form.Item label="模型" name="model" rules={[{ required: true }]}>
                    <Select
                      mode="tags"
                      placeholder="选择或输入模型名"
                      maxTagCount={1}
                      options={[
                        { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
                        { value: 'gpt-4o', label: 'gpt-4o' },
                        { value: 'gpt-3.5-turbo', label: 'gpt-3.5-turbo' },
                        { value: 'deepseek-chat', label: 'DeepSeek-V3 (deepseek-chat)' },
                        { value: 'qwen-plus', label: '通义千问 qwen-plus' },
                        { value: 'moonshot-v1-8k', label: 'Kimi moonshot-v1-8k' },
                        { value: 'glm-4-flash', label: '智谱 GLM-4-Flash' },
                      ]}
                    />
                  </Form.Item>
                </>
              );
            }
            // Ollama
            return (
              <>
                <Form.Item
                  label="Ollama 服务地址"
                  name="ollamaBaseUrl"
                  tooltip="本地默认 11434 端口。安装：https://ollama.com"
                  rules={[{ required: true }]}
                  extra={
                    <Space>
                      <a
                        href="https://ollama.com/download"
                        target="_blank"
                        rel="noreferrer"
                      >
                        下载 Ollama
                      </a>
                      <Button
                        size="small"
                        type="link"
                        onClick={async () => {
                          try {
                            const res = await window.electronAPI.fetch({
                              url: (form.getFieldValue('ollamaBaseUrl') || cfg.ollamaBaseUrl) + '/api/tags',
                              method: 'GET',
                            });
                            if (!res.ok) message.error('无法连接 Ollama：' + res.error);
                            else {
                              const obj = JSON.parse(res.body || '{}');
                              const models = (obj?.models || []).map((m: any) => m.name);
                              message.info(
                                models.length
                                  ? '已安装模型：' + models.join(', ')
                                  : 'Ollama 已连接，但尚未安装模型，可执行：ollama pull qwen2.5:7b'
                              );
                            }
                          } catch (err: any) {
                            message.error('连接失败：' + err.message);
                          }
                        }}
                      >
                        🔍 检测本地模型
                      </Button>
                    </Space>
                  }
                >
                  <Input placeholder="http://127.0.0.1:11434" />
                </Form.Item>
                <Form.Item label="模型名" name="ollamaModel" rules={[{ required: true }]}>
                  <Select
                    mode="tags"
                    maxTagCount={1}
                    placeholder="如 qwen2.5:7b, llama3.1:8b"
                    options={[
                      { value: 'qwen2.5:7b', label: 'qwen2.5:7b' },
                      { value: 'qwen2.5:14b', label: 'qwen2.5:14b' },
                      { value: 'llama3.1:8b', label: 'llama3.1:8b' },
                      { value: 'codellama:7b', label: 'codellama:7b' },
                    ]}
                  />
                </Form.Item>
              </>
            );
          }}
        </Form.Item>

        <div style={{ display: 'flex', gap: 24 }}>
          <Form.Item label="Temperature" name="temperature" style={{ flex: 1 }}>
            <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="最大输出 tokens" name="maxTokens" style={{ flex: 1 }}>
            <InputNumber min={256} max={32000} step={256} style={{ width: '100%' }} />
          </Form.Item>
        </div>

        <div
          style={{
            marginTop: 8,
            padding: 12,
            background: '#f0f9ff',
            borderRadius: 8,
            border: '1px solid #bae6fd',
            color: '#075985',
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          💡 <b>使用小贴士</b>
          <br />• 对个人/敏感数据，建议使用本地 Ollama 模型。
          <br />• 初次使用 Ollama：执行 <code>ollama pull qwen2.5:7b</code> 下载模型。
          <br />• 云端使用国内模型：将 BaseURL 改为对应厂商（如 DeepSeek：https://api.deepseek.com/v1）。
        </div>
      </Form>
    </Modal>
  );
}
